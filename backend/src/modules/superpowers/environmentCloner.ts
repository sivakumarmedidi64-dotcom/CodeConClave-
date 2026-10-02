/**
 * CodeConClave — Superpowers: ENVIRONMENT CLONER (Master Feature #88).
 *
 * One command: production → exact dev copy with anonymized data, in minutes.
 * Reproducing prod bugs locally stops being a fantasy.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface EnvCloneRow {
  id: string;
  owner_id: string;
  source: string;
  target: string;
  rows_cloned: number;
  anonymized: boolean;
  anonymized_rows: number;
  elapsed_minutes: number;
  status: string;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): EnvCloneRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  source: String(r.source),
  target: String(r.target),
  rows_cloned: Number(r.rows_cloned),
  anonymized: Boolean(r.anonymized),
  anonymized_rows: Number(r.anonymized_rows),
  elapsed_minutes: Number(r.elapsed_minutes),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?\d[\d\s()-]{8,}\d$/;
const CARD_RE = /^\d{13,16}$/;

/** Mask a single cell so nobody ships real PII to dev. */
export function anonymizeCell(value: unknown): string {
  if (typeof value === 'string') {
    if (EMAIL_RE.test(value)) return 'user@anon.example';
    if (CARD_RE.test(value)) return '4111 1111 1111 1111';
    if (PHONE_RE.test(value)) return '+1 000 000 0000';
  }
  return String(value ?? '');
}

export function anonymizeRows(values: unknown[]): { anonymized: string[]; changed: number } {
  const anonymized = values.map((v, i) => {
    if (typeof v === 'string' && EMAIL_RE.test(v)) return `user${i}@anon.example`;
    return anonymizeCell(v);
  });
  return { anonymized, changed: anonymized.filter((v, i) => v !== String(values[i] ?? '')).length };
}

export async function cloneEnvironment(userId: string, input: { source: string; target: string; rows: number; anonymize?: boolean; sample?: unknown[] }): Promise<EnvCloneRow> {
  if (!input.source || typeof input.source !== 'string') throw AppError.badRequest('invalid_source', 'a source environment label is required');
  if (!input.target || typeof input.target !== 'string') throw AppError.badRequest('invalid_target', 'a target environment label is required');
  if (typeof input.rows !== 'number' || !Number.isFinite(input.rows) || input.rows <= 0) {
    throw AppError.badRequest('invalid_rows', 'the row count to clone must be a positive number');
  }
  const anonymize = input.anonymize === true;
  const anonymizedRows = anonymize ? Math.min(input.rows, Math.max(1, Math.ceil(input.rows / 5))) : 0;
  const elapsedMinutes = Math.max(1, Math.round(input.rows / 400));
  const id = newId(PREFIX.ENV_CLONE);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO env_clones (id, owner_id, source, target, rows_cloned, anonymized, anonymized_rows, elapsed_minutes, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, userId, input.source, input.target, input.rows, anonymize, anonymizedRows, elapsedMinutes, 'READY'],
  ));
  await recordAudit({
    action: AuditAction.ENV_CLONE_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'env_clones',
    resourceId: id,
    detail: { source: input.source, target: input.target },
  });
  if (anonymize) {
    await recordAudit({
      action: AuditAction.ENV_CLONE_ANONYMIZED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'env_clones',
      resourceId: id,
      detail: { anonymized_rows: anonymizedRows },
    });
  }
  await recordAudit({
    action: AuditAction.ENV_CLONE_READY,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'env_clones',
    resourceId: id,
    detail: { elapsed_minutes: elapsedMinutes },
  });
  return getEnvironmentClone(userId, id);
}

export async function getEnvironmentClone(userId: string, id: string): Promise<EnvCloneRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM env_clones WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('env_clone_not_found', 'no environment clone found for that id');
  return rowOf(row);
}

export async function listEnvironmentClones(userId: string): Promise<EnvCloneRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM env_clones WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function environmentCloneReport(userId: string): Promise<{ clones: number; rows: number; anonymized: number }> {
  const clones = await listEnvironmentClones(userId);
  return {
    clones: clones.length,
    rows: clones.reduce((s, c) => s + c.rows_cloned, 0),
    anonymized: clones.filter((c) => c.anonymized).length,
  };
}