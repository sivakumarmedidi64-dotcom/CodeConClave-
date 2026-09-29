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

export const SECRET_GUARD_TARGETS = Object.values(SecretGuardTarget) as string[];

interface SecretPattern {
  kind: string;
  label: string;
  re: RegExp;
  confidence: number;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { kind: 'aws_access_key_id', label: 'AWS access key ID', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, confidence: 0.95 },
  { kind: 'aws_secret_access_key', label: 'AWS secret access key', re: /\b(?<![A-Za-z0-9])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g, confidence: 0.7 },
  { kind: 'github_pat', label: 'GitHub personal access token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, confidence: 0.95 },
  { kind: 'github_oauth', label: 'GitHub OAuth token', re: /\bgho_[A-Za-z0-9]{36,}\b/g, confidence: 0.95 },
  { kind: 'slack_token', label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, confidence: 0.95 },
  { kind: 'private_key', label: 'Private key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, confidence: 1 },
  { kind: 'google_api_key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, confidence: 0.95 },
  { kind: 'stripe_secret', label: 'Stripe secret key', re: /\bsk_live_[0-9A-Za-z]{24,}\b/g, confidence: 0.95 },
  { kind: 'openrouter_api_key', label: 'OpenRouter API key', re: /\bsk-or-v1-[0-9A-Za-z_-]{32,}\b/g, confidence: 0.95 },
  { kind: 'generic_api_key', label: 'API key', re: /\b(?:api[_-]?key|apikey|secret(?:[_-]?key)?|access[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}/gi, confidence: 0.6 },
  { kind: 'jwt', label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, confidence: 0.9 },
  { kind: 'connection_string', label: 'Connection string', re: /\b(?:postgres(?:ql)?|mysql|redis|amqp|mongodb(?:\+srv)?):\/\/[^\s"'<>]{6,}\b/gi, confidence: 0.9 },
];

export interface SecretFinding {
  kind: string;
  label: string;
  location: number;
  confidence: number;
}

export interface SecretGuardRow {
  id: string;
  owner_id: string;
  target_type: string;
  target_ref: string | null;
  result: 'CLEAN' | 'FINDINGS';
  findings: SecretFinding[];
  scanned_at: Date;
}

export function scanContentForSecrets(content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const text = String(content ?? '');
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : pattern.re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      findings.push({
        kind: pattern.kind,
        label: pattern.label,
        location: m.index,
        confidence: pattern.confidence,
      });
      if (re.lastIndex === m.index) re.lastIndex++;
      if (findings.length >= 50) break;
    }
    if (findings.length >= 50) break;
  }
  findings.sort((a, b) => a.location - b.location);
  return findings;
}

/** Replace secret matches with placeholders so secrets are never logged. */
export function redactSecrets(content: string): string {
  let out = String(content ?? '');
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern.re, (m) => {
      const n = pattern.label;
      return m.length > 8 ? `[REDACTED:${n}]` : m;
    });
  }
  return out;
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