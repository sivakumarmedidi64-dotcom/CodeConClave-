/**
 * CodeConClave — Superpowers: FRESH-EYES REVIEW (Master Feature #11).
 *
 * An agent with ZERO project context reviews your code like an outside
 * contractor — blind to team conventions and blind to the technical debt you
 * have normalized. Unlike context-rich review, Fresh Eyes runs DETERMINISTIC
 * blind-spot analyzers (no model, no training bias) so the findings are
 * reproducible, provable and exactly the things trained agents learn to ignore:
 *
 *   1. MAGIC_NUMBERS   bare non-trivial numeric literals in logic
 *   2. TODO_DEBT        TODO / FIXME / HACK / XXX markers left in code
 *   3. SUSPECTED_SECRETS an api key / token shaped literal in the diff
 *   4. SWALLOWED_ERRORS empty catch/except blocks (errors disappear)
 *   5. DUPLICATED_LITERALS the same long string repeated 3+ times
 *   6. LEFTOVER_LOG     console.log / debug prints reaching production code
 *
 * Every finding carries concrete evidence + why-now + a suggestion. Reviews are
 * honest: CLEAN when nothing fires, FLAGGED otherwise, and each can be linked
 * to a PROOF claim for providability. Statuses close explicitly (RESOLVED /
 * DISMISSED).
 */
import { withTenant, queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface Finding {
  rule: string;
  evidence: string;
  why: string;
  suggestion: string;
}

export interface FreshEyesInput {
  file?: string | null;
  code: string;
  taskId?: string | null;
  projectId?: string | null;
  contextNote?: string | null;
}

export interface FreshEyesReviewRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  task_id: string | null;
  file: string | null;
  input: string;
  findings: Finding[];
  verdict: 'CLEAN' | 'FLAGGED';
  outside_perspective: string;
  inside_perspective: string | null;
  proof_claim_id: string | null;
  status: 'OPEN' | 'RESOLVED' | 'DISMISSED';
  created_at: Date;
  updated_at: Date;
}

/** Deterministic blind-spot analyzers — pure, unit-testable, bias-free. */

export function fireWallNoise(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/^\s*\n/gm, '');
}

export interface MagicNumberHit { literal: string }
export function detectMagicNumbers(code: string): MagicNumberHit[] {
  const body = fireWallNoise(code);
  const hits: MagicNumberHit[] = [];
  const re = /\b\d{2,}(?:\.\d+)?\b|\b\d+\.\d+\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const literal = m[0];
    const numeric = Number(literal);
    if (numeric <= 10 && !literal.includes('.')) continue;
    hits.push({ literal });
    if (hits.length >= 8) break;
  }
  return hits;
}

export function detectTodoMarks(code: string): string[] {
  return [...new Set([...code.matchAll(/(?:TODO|FIXME|HACK|XXX):?\s+([^\n]*)/gi)].map((m) => m[1]!.trim()).filter(Boolean))].slice(0, 10);
}

export function detectSuspectedSecrets(code: string): string[] {
  const hits: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/\b(sk[a-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g, 'api token literal'],
    [/["'](?:api[_-]?key|secret|token|password)["']\s*[:=]\s*["'][^"']{8,}["']/gi, 'named secret assignment (quoted)'],
    [/\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][^"']{8,}["']/gi, 'named secret assignment'],
  ];
  for (const [re, label] of patterns) {
    for (const m of code.matchAll(re)) {
      const line = (code.slice(0, m.index).split('\n').pop() ?? '').trim();
      hits.push(`${label} at "${line.slice(0, 80)}"`);
    }
  }
  return hits.slice(0, 5);
}

export function detectSwallowedErrors(code: string): string[] {
  const hits: string[] = [];
  const catchRe = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
  for (const m of code.matchAll(catchRe)) {
    hits.push(`empty catch block at ${code.slice(0, m.index).split('\n').length}`);
  }
  const exceptRe = /\bexcept[^:]*:\s*pass/g;
  for (const m of code.matchAll(exceptRe)) hits.push('exception handler passes silently');
  return hits.slice(0, 8);
}

export function detectDuplicatedLiterals(code: string): string[] {
  const body = fireWallNoise(code);
  const strings = [...body.matchAll(/["'`]([^"'`]{12,})["'`]/g)].map((m) => m[1]!);
  const counts = new Map<string, number>();
  for (const s of strings) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n >= 3).map(([s, n]) => `"${s}" repeated ${n} times`).slice(0, 8);
}

export function detectLeftoverLogs(code: string): string[] {
  const logs = [...code.matchAll(/\b(?:console\.(?:log|debug)|println|print\s*\()/g)];
  return logs.slice(0, 8).map((m, i) => `debug print in production code at line ${code.slice(0, m.index ?? 0).split('\n').length}`);
}

export function analyzeFreshEyes(code: string): Finding[] {
  const findings: Finding[] = [];
  for (const hit of detectMagicNumbers(code).slice(0, 4)) {
    findings.push({
      rule: 'MAGIC_NUMBERS',
      evidence: hit.literal,
      why: 'A bare non-trivial number signals a meaning only you know — a future editor cannot tell 14400 from 86400 on sight.',
      suggestion: 'Extract it into a named constant with the unit in the name (e.g. CACHE_TTL_SECONDS).',
    });
  }
  for (const mark of detectTodoMarks(code)) {
    findings.push({
      rule: 'TODO_DEBT',
      evidence: mark,
      why: 'Deferred work is invisible risk: your trained agents have learned to skim past it, an outside eye stops on it.',
      suggestion: 'Convert it into a tracked task (New Echo -> fix_ticket) with a definition of done instead of a comment.',
    });
  }
  for (const s of detectSuspectedSecrets(code)) {
    findings.push({
      rule: 'SUSPECTED_SECRETS',
      evidence: s,
      why: 'Credentials in reachable code are a blocker the moment the repo is shared; your context has normalized the pattern.',
      suggestion: 'Move the value to the secret store and read it at runtime; never commit the literal.',
    });
  }
  for (const e of detectSwallowedErrors(code)) {
    findings.push({
      rule: 'SWALLOWED_ERRORS',
      evidence: e,
      why: 'An empty catch means failures vanish silently — the hardest class of bug (undiagnosable).',
      suggestion: 'Log the error or rethrow; if truly ignorable, comment the exact reason.',
    });
  }
  for (const dup of detectDuplicatedLiterals(code)) {
    findings.push({
      rule: 'DUPLICATED_LITERALS',
      evidence: dup,
      why: 'Repeated literals drift apart over time; your team has grown tolerant of the pattern.',
      suggestion: 'Hoist to one named constant imported everywhere the value is used.',
    });
  }
  for (const log of detectLeftoverLogs(code)) {
    findings.push({
      rule: 'LEFTOVER_LOG',
      evidence: log,
      why: 'Debug output in reachable code leaks noisy, sometimes sensitive, output.',
      suggestion: 'Use structured logging through the app logger or remove the print entirely.',
    });
  }
  return findings.slice(0, 20);
}

export function outsidePerspective(findings: Finding[]): string {
  if (findings.length === 0) {
    return 'A cold look with no project context: nothing here violates plain-code sanity. No magic numbers, no deferred work comments, no secrets, no swallowed errors, no duplicated literals, no debug prints. Treat it as low-risk from an outside contractor\'s perspective.';
  }
  return `As an outside contractor with zero team context, I flag ${findings.length} blind spot(s): ${findings.map((f) => f.rule.toLowerCase()).join(', ')}. Trained teammates likely normalize these; a fresh set of eyes does not.`;
}

function rowOf(r: Record<string, unknown>): FreshEyesReviewRow {
  const f = r.findings && typeof r.findings === 'object' && Array.isArray(r.findings) ? (r.findings as Finding[]) : [];
  return {
    id: String(r.id),
    owner_id: String(r.owner_id),
    project_id: r.project_id === null ? null : String(r.project_id),
    task_id: r.task_id === null ? null : String(r.task_id),
    file: r.file === null ? null : String(r.file),
    input: String(r.input),
    findings: f,
    verdict: String(r.verdict) as FreshEyesReviewRow['verdict'],
    outside_perspective: String(r.outside_perspective ?? ''),
    inside_perspective: r.inside_perspective === null ? null : String(r.inside_perspective),
    proof_claim_id: r.proof_claim_id === null ? null : String(r.proof_claim_id),
    status: String(r.status) as FreshEyesReviewRow['status'],
    created_at: new Date(String(r.created_at)),
    updated_at: new Date(String(r.updated_at)),
  };
}

export async function runFreshEyesReview(userId: string, input: FreshEyesInput): Promise<FreshEyesReviewRow> {
  const code = (input.code ?? '').trim();
  if (!code) throw AppError.badRequest('code_required', 'code (or a diff) is required for a fresh-eyes review');
  const findings = analyzeFreshEyes(code);
  const verdict: FreshEyesReviewRow['verdict'] = findings.length === 0 ? 'CLEAN' : 'FLAGGED';
  const outside = outsidePerspective(findings);
  const id = newId(PREFIX.FRESH_EYES_REVIEW);
  await withTenant(userId, (q) => q.query(
    `INSERT INTO fresh_eyes_reviews (id, owner_id, project_id, task_id, file, input, findings, verdict, outside_perspective, inside_perspective)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
    [
      id, userId, input.projectId ?? null, input.taskId ?? null, input.file ?? null,
      code, JSON.stringify(findings), verdict, outside, input.contextNote ?? null,
    ],
  ));
  await recordAudit({
    action: AuditAction.FRESH_EYES_REVIEWED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'fresh_eyes_reviews',
    resourceId: id,
    detail: { verdict, findings: findings.length, file: input.file ?? null },
  });
  return getFreshEyesReview(userId, id);
}

export async function getFreshEyesReview(userId: string, reviewId: string): Promise<FreshEyesReviewRow> {
  const rows = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>(
    'SELECT * FROM fresh_eyes_reviews WHERE id = $1 AND owner_id = $2',
    [reviewId, userId],
  )).rows);
  if (!rows[0]) throw AppError.notFound('Fresh-eyes review');
  return rowOf(rows[0]);
}

export async function listFreshEyesReviews(userId: string, opts: { status?: FreshEyesReviewRow['status']; verdict?: FreshEyesReviewRow['verdict'] } = {}): Promise<FreshEyesReviewRow[]> {
  const where: string[] = ['owner_id = $1'];
  const params: unknown[] = [userId];
  if (opts.status) { where.push(`status = $${params.length + 1}`); params.push(opts.status); }
  if (opts.verdict) { where.push(`verdict = $${params.length + 1}`); params.push(opts.verdict); }
  return (await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (
      await q.query<Record<string, unknown>>(
        `SELECT * FROM fresh_eyes_reviews WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
        params,
      )
    ).rows,
  )).map(rowOf);
}

export async function linkProofClaim(userId: string, reviewId: string, proofClaimId: string): Promise<FreshEyesReviewRow> {
  const review = await getFreshEyesReview(userId, reviewId);
  if (!proofClaimId.trim()) throw AppError.badRequest('proof_claim_id_required', 'proofClaimId is required');
  await withTenant(userId, (q) => q.query(
    'UPDATE fresh_eyes_reviews SET proof_claim_id = $1, updated_at = now() WHERE id = $2 AND owner_id = $3',
    [proofClaimId.trim(), reviewId, userId],
  ));
  return getFreshEyesReview(userId, reviewId);
}

export async function closeFreshEyesReview(userId: string, reviewId: string, status: 'RESOLVED' | 'DISMISSED'): Promise<FreshEyesReviewRow> {
  const review = await getFreshEyesReview(userId, reviewId);
  if (review.status !== 'OPEN') return review;
  await withTenant(userId, (q) => q.query(
    'UPDATE fresh_eyes_reviews SET status = $1, updated_at = now() WHERE id = $2 AND owner_id = $3',
    [status, reviewId, userId],
  ));
  await recordAudit({
    action: AuditAction.FRESH_EYES_CLOSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'fresh_eyes_reviews',
    resourceId: reviewId,
    detail: { status },
  });
  return getFreshEyesReview(userId, reviewId);
}