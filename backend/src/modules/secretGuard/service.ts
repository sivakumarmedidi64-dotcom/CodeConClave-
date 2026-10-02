/**
 * Stage 26G — secret guard.
 *
 * Scans text content (agent output, files, commits, memory, task payloads)
 * for known secret patterns. Findings record the secret KIND, location and a
 * confidence score — NEVER the secret value. `redactSecrets` replaces matches
 * with placeholders so callers can log/surface content without leaking
 * secrets. Scan results are persisted to secret_guard_scans.
 */
import { withTenant, queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { AuditAction, NotificationType, SecretGuardTarget } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { SECRET_PATTERNS, scanContentForSecrets, redactSecrets } from './patterns.js';
import type { SecretPattern, SecretFinding } from './patterns.js';

export { SECRET_PATTERNS, scanContentForSecrets, redactSecrets } from './patterns.js';
export type { SecretPattern, SecretFinding } from './patterns.js';

export const SECRET_GUARD_TARGETS = Object.values(SecretGuardTarget) as string[];

export interface SecretGuardRow {
  id: string;
  owner_id: string;
  target_type: string;
  target_ref: string | null;
  result: 'CLEAN' | 'FINDINGS';
  findings: SecretFinding[];
  scanned_at: Date;
}

/** Scan content and persist an honest result (findings never contain values). */
export async function scanContent(
  userId: string,
  input: { targetType: string; targetRef?: string; content: string },
): Promise<SecretGuardRow> {
  if (!SECRET_GUARD_TARGETS.includes(input.targetType)) {
    throw AppError.badRequest('invalid_scan_target', `Unknown scan target ${input.targetType}`);
  }
  const findings = scanContentForSecrets(input.content);
  const id = newId(PREFIX.SECRET_GUARD_SCAN);
  const { pool } = await import('../../shared/db.js');
  await withTenant(userId, (q) => q.query(
    `INSERT INTO secret_guard_scans (id, owner_id, target_type, target_ref, result, findings)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [id, userId, input.targetType, input.targetRef ?? null, findings.length > 0 ? 'FINDINGS' : 'CLEAN', JSON.stringify(findings)],
  ));
  await recordAudit({
    action: findings.length > 0 ? AuditAction.SECRET_GUARD_FINDINGS : AuditAction.SECRET_GUARD_SCANNED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'secret_guard_scan',
    resourceId: id,
    detail: {
      targetType: input.targetType,
      targetRef: input.targetRef ?? null,
      findingCount: findings.length,
      kinds: [...new Set(findings.map((f) => f.kind))],
    },
  });
  if (findings.length > 0) {
    await notify(userId, NotificationType.SECRET_GUARD_ALERT, 'Secrets detected in scanned content', {
      body: `${findings.length} potential secret(s) found in ${input.targetType}${input.targetRef ? ` (${input.targetRef})` : ''}`,
      resourceType: 'secret_guard_scan',
      resourceId: id,
      metadata: { kinds: [...new Set(findings.map((f) => f.kind))] },
    }).catch(() => undefined);
  }
  return { id, owner_id: userId, target_type: input.targetType, target_ref: input.targetRef ?? null, result: findings.length > 0 ? 'FINDINGS' : 'CLEAN', findings, scanned_at: new Date() };
}

export async function listSecretGuardScans(userId: string, limit = 50): Promise<SecretGuardRow[]> {
  return withTenant<SecretGuardRow[]>(userId, async (q) =>
    (
      await q.query<SecretGuardRow>(
        'SELECT * FROM secret_guard_scans WHERE owner_id = $1 ORDER BY scanned_at DESC LIMIT $2',
        [userId, Math.min(Math.max(limit, 1), 200)],
      )
    ).rows,
  );
}