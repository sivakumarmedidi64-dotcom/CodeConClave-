/**
 * CodeConClave — Superpowers: ANOMALY HUNTER (Master Feature #46).
 *
 * Continuously diffs "what the code does" against "what the code says it
 * does" — names, comments and test descriptions. The checks are DETERMINISTIC
 * (no model, provable) so each finding is a real mismatch you can read:
 *
 *   READER_THAT_MUTATES   a function named get/fetch/read/load whose body
 *                         deletes, removes, drops or wipes rows/keys.
 *   DESTRUCTIVE_SURPRISE  a function named add/create/save that also mutates
 *                         destructively inside — surprising side effects.
 *   HOLLOW_TEST_CLAIMS    a test named "returns/throws/works/validates X"
 *                         whose body has no expect/assert — it claims without
 *                         checking.
 *   MISSING_GUARD         a doc comment claiming "validates" / "guards" while
 *                         the body has no condition + throw/return — the
 *                         claimed safety net does not exist.
 *
 * Scans are honest (CLEAN / FLAGGED), owner-scoped, audited and closable
 * (RESOLVED / DISMISSED) — same lifecycle as Fresh-Eyes Review (#11).
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type AnomalyTargetType = 'CODE' | 'TEST' | 'DOC';
export type AnomalyVerdict = 'CLEAN' | 'FLAGGED';
export type AnomalyStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED';

export interface AnomalyFinding {
  rule: string;
  evidence: string;
  why: string;
  suggestion: string;
}

export interface AnomalyScanRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  target_type: AnomalyTargetType;
  target_path: string | null;
  verdict: AnomalyVerdict;
  findings: AnomalyFinding[];
  status: AnomalyStatus;
  created_at: Date;
  updated_at: Date;
}

export interface AnomalyInput {
  targetType: AnomalyTargetType;
  code: string;
  targetPath?: string | null;
  projectId?: string | null;
}

/** Code trimmed of /*...* / and // comments. */
export function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

const MUTATE_RE = /\b(?:delete|remove|destroy|drop|purge|wipe|clear)\b/gi;
const isReaderName = (name: string) => /^(?:get|fetch|read|load|find|lister|list)\w*$/i.test(name);
const isWriterName = (name: string) => /^(?:add|create|save|insert|write|new)\w*$/i.test(name);
const isMutation = (slice: string) => MUTATE_RE.test(slice);

export function detectReaderThatMutates(code: string): AnomalyFinding[] {
  const body = stripComments(code);
  const out: AnomalyFinding[] = [];
  for (const m of code.matchAll(/^\s*(?:export\s+(?:async\s+)?function|function|const)\s*([a-zA-Z_$][\w$]*)\s*(?:=|\(|:)/gm)) {
    const name = m[1]!;
    const bodyStart = (m.index ?? 0) + m[0].length;
    const slice = body.slice(bodyStart, bodyStart + 900);
    if (isReaderName(name) && isMutation(slice)) {
      out.push({
        rule: 'READER_THAT_MUTATES',
        evidence: `${name} is named as a reader (get/fetch/read/load) but its body deletes/removes/drops.`,
        why: 'Callers of a getter assume it is side-effect free. A getter that mutates is the classic dangling surprise bug.',
        suggestion: `Rename ${name} (e.g. deleteX / clearX) or move the mutation out of the read path.`,
      });
    }
  }
  return out;
}

export function detectDestructiveSurprise(code: string): AnomalyFinding[] {
  const body = stripComments(code);
  const out: AnomalyFinding[] = [];
  for (const m of code.matchAll(/^\s*(?:export\s+(?:async\s+)?function|function|const)\s*([a-zA-Z_$][\w$]*)\s*(?:=|\(|:)/gm)) {
    const name = m[1]!;
    const bodyStart = (m.index ?? 0) + m[0].length;
    const slice = body.slice(bodyStart, bodyStart + 900);
    if (isWriterName(name) && isMutation(slice)) {
      out.push({
        rule: 'DESTRUCTIVE_SURPRISE',
        evidence: `${name} is named as a creator/writer (add/create/save) but its body also deletes/drops/wipes.`,
        why: 'A "save" that clears records is impossible to reason about from the call sites.',
        suggestion: `Split the destructive operation out of ${name} into its own named step.`,
      });
    }
  }
  return out;
}

export function detectHollowTestClaims(code: string): AnomalyFinding[] {
  const out: AnomalyFinding[] = [];
  const itRe = /^\s*(?:it|test)\s*\(\s*["'`]([^"'`]+)["'`]\s*,/gm;
  let m: RegExpExecArray | null;
  while ((m = itRe.exec(code)) !== null) {
    const title = m[1]!;
    const slice = code.slice(m.index ?? 0, (m.index ?? 0) + 700);
    const hasAssert = /\b(?:expect|assert|assertThat|ok)\s*\(/.test(slice) || /\b(?:self\.)?assert\w*\s*\(/.test(slice);
    if (!hasAssert) {
      out.push({
        rule: 'HOLLOW_TEST_CLAIMS',
        evidence: `"${title}" describes a behavior but the block never asserts anything.`,
        why: 'A test that does not assert cannot fail — it pads the suite with false confidence.',
        suggestion: 'Add the expected outcome (expect/assert) or the test is a no-op and should be removed.',
      });
    }
  }
  return out;
}

export function detectMissingGuard(code: string): AnomalyFinding[] {
  const body = stripComments(code);
  const out: AnomalyFinding[] = [];
  const commentRe = /\/\/[^\n]*|\/\*[\s\S]*?\*\//gm;
  let m: RegExpExecArray | null;
  while ((m = commentRe.exec(code)) !== null) {
    const comment = m[0]!;
    const claims = /(?:validat|guard|sanitiz|checks? that|ensures)/i.test(comment);
    if (!claims) continue;
    const after = code.slice(m.index ?? 0, (m.index ?? 0) + 900);
    const hasCondition = /\b(?:if|switch|try)\b/.test(after);
    const hasEnforcement = /\b(?:throw|return\s+null|return\s+false|new\s+Error|AppError)\b/.test(after);
    if (hasCondition && hasEnforcement) continue;
    out.push({
      rule: 'MISSING_GUARD',
      evidence: `comment "${comment.trim().slice(0, 90)}" claims validation, the following code has no condition + throw/return.`,
      why: 'Documentation promises a safety net the code does not provide — a lie that ships as a comment.',
      suggestion: 'Add the actual guard (validate then throw / return an error) or drop the claim from the comment.',
    });
  }
  return out;
}

export function analyzeAnomalies(targetType: AnomalyTargetType, code: string): AnomalyFinding[] {
  const findings: AnomalyFinding[] = [];
  if (targetType === 'CODE' || targetType === 'DOC') {
    findings.push(...detectReaderThatMutates(code), ...detectDestructiveSurprise(code), ...detectMissingGuard(code));
  }
  if (targetType === 'TEST' || targetType === 'CODE') {
    findings.push(...detectHollowTestClaims(code));
  }
  return findings.slice(0, 20);
}

function rowOf(r: Record<string, unknown>): AnomalyScanRow {
  return {
    id: String(r.id),
    owner_id: String(r.owner_id),
    project_id: r.project_id === null ? null : String(r.project_id),
    target_type: String(r.target_type) as AnomalyTargetType,
    target_path: r.target_path === null ? null : String(r.target_path),
    verdict: String(r.verdict) as AnomalyVerdict,
    findings: Array.isArray(r.findings) ? (r.findings as AnomalyFinding[]) : [],
    status: String(r.status) as AnomalyStatus,
    created_at: new Date(String(r.created_at)),
    updated_at: new Date(String(r.updated_at)),
  };
}

export async function getAnomalyScan(userId: string, scanId: string): Promise<AnomalyScanRow> {
  const rows = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>(
    'SELECT * FROM anomaly_scans WHERE id = $1 AND owner_id = $2',
    [scanId, userId],
  )).rows);
  if (!rows[0]) throw AppError.notFound('Anomaly scan');
  return rowOf(rows[0]);
}

export async function runAnomalyScan(userId: string, input: AnomalyInput): Promise<AnomalyScanRow> {
  if (!['CODE', 'TEST', 'DOC'].includes(input.targetType)) {
    throw AppError.badRequest('invalid_target_type', 'targetType must be CODE, TEST or DOC');
  }
  const code = (input.code ?? '').trim();
  if (!code) throw AppError.badRequest('code_required', 'code is required for an anomaly scan');
  const findings = analyzeAnomalies(input.targetType, code);
  const verdict: AnomalyVerdict = findings.length === 0 ? 'CLEAN' : 'FLAGGED';
  const id = newId(PREFIX.ANOMALY_SCAN);
  await withTenant(userId, (q) => q.query(
    `INSERT INTO anomaly_scans (id, owner_id, project_id, target_type, target_path, verdict, findings, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'OPEN')`,
    [id, userId, input.projectId ?? null, input.targetType, input.targetPath ?? null, verdict, JSON.stringify(findings)],
  ));
  await recordAudit({
    action: AuditAction.ANOMALY_SCAN_COMPLETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'anomaly_scans',
    resourceId: id,
    detail: { targetType: input.targetType, verdict, findings: findings.length },
  });
  return getAnomalyScan(userId, id);
}

export async function listAnomalyScans(userId: string, opts: { status?: AnomalyStatus; verdict?: AnomalyVerdict } = {}): Promise<AnomalyScanRow[]> {
  const rows = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>(
    'SELECT * FROM anomaly_scans WHERE owner_id = $1',
    [userId],
  )).rows);
  return rows
    .map(rowOf)
    .filter((r) => (opts.status ? r.status === opts.status : true) && (opts.verdict ? r.verdict === opts.verdict : true))
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}

export async function closeAnomalyScan(userId: string, scanId: string, status: 'RESOLVED' | 'DISMISSED'): Promise<AnomalyScanRow> {
  const scan = await getAnomalyScan(userId, scanId);
  if (scan.status !== 'OPEN') return scan;
  await withTenant(userId, (q) => q.query(
    'UPDATE anomaly_scans SET status = $1, updated_at = now() WHERE id = $2 AND owner_id = $3',
    [status, scanId, userId],
  ));
  await recordAudit({
    action: AuditAction.ANOMALY_SCAN_CLOSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'anomaly_scans',
    resourceId: scanId,
    detail: { status },
  });
  return getAnomalyScan(userId, scanId);
}