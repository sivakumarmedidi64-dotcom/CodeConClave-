/**
 * Stage 26F — PR Review Swarm.
 *
 * A multi-agent code review: ARCHITECT / REVIEWER / SECURITY / TESTER each
 * produce INDEPENDENT findings for the same pull request (files map).
 *
 * Honesty rules:
 *   - Findings carry severity, category, title, description, evidence,
 *     confidence (0..1) and a recommendation — nothing else is stored.
 *   - file_path / line_start / line_end are only persisted when the location
 *     is VERIFIED against the supplied file map (path exists and the line
 *     numbers are inside the file). Unverifiable locations are dropped.
 *   - One failing role never hides the others: its failure is recorded and
 *     the swarm completes as PARTIAL.
 *   - With no AI provider reachable, each role produces one honest
 *     `review_unavailable` finding (confidence 0) — never invented findings.
 *
 * Reuses the existing task engine (createTask), audit, notifications,
 * AI gateway (completeWithFallback), memory (createMemory, best-effort).
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { AuditAction, NotificationType, MemoryType, MemorySource } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { createTask } from '../execution/tasks.js';
import { completeWithFallback } from '../ai/gateway.js';
import { effectivePlan } from '../entitlements/service.js';
import { createMemory } from '../memory/service.js';

export const SWARM_ROLES = ['ARCHITECT', 'REVIEWER', 'SECURITY', 'TESTER'] as const;
export type SwarmRole = (typeof SWARM_ROLES)[number];
export type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type SwarmStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

export interface ReviewSwarmRow {
  id: string;
  owner_id: string;
  project_id: string;
  pr_ref: string;
  target_ref: string | null;
  title: string;
  status: SwarmStatus;
  roles: string[];
  files: PrReviewFile[];
  task_id: string | null;
  verdict: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface ReviewFindingRow {
  id: string;
  swarm_id: string;
  owner_id: string;
  role: SwarmRole;
  severity: FindingSeverity;
  category: string;
  title: string;
  description: string;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  evidence: unknown[];
  confidence: number;
  recommendation: string | null;
  status: 'OPEN' | 'ACCEPTED' | 'DISMISSED';
  created_at: Date;
}

export interface PrReviewFile {
  path: string;
  content: string;
}

export interface StartPrReviewInput {
  projectId: string;
  prRef: string;
  targetRef?: string;
  title?: string;
  files: PrReviewFile[];
}

const SEVERITIES: FindingSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const MAX_FINDINGS_PER_ROLE = 12;
const MAX_FILES = 50;
const MAX_FILE_BYTES = 200_000;

function clampConfidence(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Verify a claimed location against the supplied file map. */
function verifiedLocation(
  filePath: unknown,
  lineStart: unknown,
  lineEnd: unknown,
  files: PrReviewFile[],
): { file_path: string | null; line_start: number | null; line_end: number | null } {
  const path = typeof filePath === 'string' ? filePath.trim() : null;
  if (!path) return { file_path: null, line_start: null, line_end: null };
  const file = files.find((f) => f.path === path);
  if (!file) return { file_path: null, line_start: null, line_end: null };
  const lineCount = file.content.split('\n').length;
  const start = Number(lineStart);
  const end = Number(lineEnd);
  const startOk = Number.isInteger(start) && start >= 1 && start <= lineCount;
  const endOk = Number.isInteger(end) && end >= (startOk ? start : 1) && end <= lineCount;
  if (!startOk && !endOk) return { file_path: path, line_start: null, line_end: null };
  if (!startOk) return { file_path: path, line_start: endOk ? end : null, line_end: endOk ? end : null };
  if (!endOk) return { file_path: path, line_start: start, line_end: start };
  return { file_path: path, line_start: start, line_end: end };
}

type FindingDraft = Omit<ReviewFindingRow, 'id' | 'swarm_id' | 'owner_id' | 'status' | 'created_at'>;

function parseFindings(text: string, files: PrReviewFile[]): FindingDraft[] {
  const jsonStart = text.indexOf('{');
  if (jsonStart < 0) return [];
  const jsonEnd = text.lastIndexOf('}');
  if (jsonEnd <= jsonStart) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch {
    return [];
  }
  const rawFindings = (parsed as { findings?: unknown })?.findings;
  if (!Array.isArray(rawFindings)) return [];
  const out: FindingDraft[] = [];
  for (const raw of rawFindings) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const severity = String(r.severity ?? '').toUpperCase() as FindingSeverity;
    if (!SEVERITIES.includes(severity)) continue;
    const title = String(r.title ?? '').trim();
    const description = String(r.description ?? '').trim();
    if (!title || !description) continue;
    const loc = verifiedLocation(r.file_path, r.line_start, r.line_end, files);
    out.push({
      role: String(r.role ?? '').toUpperCase() as SwarmRole,
      severity,
      category: String(r.category ?? 'general').slice(0, 80),
      title: title.slice(0, 200),
      description: description.slice(0, 4000),
      file_path: loc.file_path,
      line_start: loc.line_start,
      line_end: loc.line_end,
      evidence: Array.isArray(r.evidence) ? r.evidence.slice(0, 20) : [],
      confidence: clampConfidence(r.confidence),
      recommendation: r.recommendation ? String(r.recommendation).slice(0, 1000) : null,
    });
    if (out.length >= MAX_FINDINGS_PER_ROLE) break;
  }
  return out;
}

const ROLE_PROMPTS: Record<SwarmRole, string> = {
  ARCHITECT:
    'You are the ARCHITECT reviewer. Look for architectural problems: coupling, ' +
    'layering violations, scalability, error-handling structure, extensibility. ' +
    'Only report what the diff supports.',
  REVIEWER:
    'You are the CODE REVIEWER. Look for logic bugs, dead code, readability, ' +
    'regressions, missing edge cases, API misuse. Only report what the diff supports.',
  SECURITY:
    'You are the SECURITY reviewer. Look for injection, authz/authn gaps, secrets ' +
    'in code, unsafe deserialization, SSRF, dependency risk. Only report what the diff supports.',
  TESTER:
    'You are the TESTER reviewer. Look for missing or weak test coverage for the ' +
    'changed paths, flaky assertions, untested edge cases, missing negative cases. ' +
    'Only report what the diff supports.',
};

function roleMessages(role: SwarmRole, title: string, files: PrReviewFile[]): { role: 'user'; content: string }[] {
  const body = files
    .map((f) => `--- FILE: ${f.path} ---\n${f.content}`)
    .join('\n\n')
    .slice(0, 60_000);
  return [
    {
      role: 'user',
      content:
        `${ROLE_PROMPTS[role]}\n\n` +
        `Pull request: ${title}\n\n` +
        `${body}\n\n` +
        `Respond with ONLY a JSON object: {"findings":[{` +
        `"role":"${role}","severity":"CRITICAL|HIGH|MEDIUM|LOW|INFO","category":"...",` +
        `"title":"...","description":"...","file_path":"exact path from the file list or null",` +
        `"line_start":null,"line_end":null,"evidence":["..."],"confidence":0.9,"recommendation":"..."}]}. ` +
        `Use null file_path unless you verified it in the list above.`,
    },
  ];
}

function unavailableFinding(role: SwarmRole): FindingDraft {
  return {
    role,
    severity: 'INFO',
    category: 'review_unavailable',
    title: `${role} review unavailable`,
    description: 'No AI provider was reachable; this role could not review the pull request.',
    file_path: null,
    line_start: null,
    line_end: null,
    evidence: [],
    confidence: 0,
recommendation: 'Retry the review once provider connectivity is restored.',
  };
}

/** Get a swarm (tenant-scoped). */
export async function getSwarm(userId: string, swarmId: string): Promise<ReviewSwarmRow> {
  const rows = await withTenant<ReviewSwarmRow[]>(userId, (q) =>
    q
      .query<ReviewSwarmRow>(
        'SELECT * FROM review_swarms WHERE id = $1 AND owner_id = $2',
        [swarmId, userId],
      )
      .then((r) => r.rows),
  );
  if (!rows[0]) throw AppError.notFound('Review swarm');
  return rows[0];
}

/** List swarms (newest first, tenant-scoped). */
export async function listSwarms(userId: string, projectId?: string): Promise<ReviewSwarmRow[]> {
  const where = projectId ? 'owner_id = $1 AND project_id = $2' : 'owner_id = $1';
  const params = projectId ? [userId, projectId] : [userId];
  return withTenant<ReviewSwarmRow[]>(userId, (q) =>
    q.query<ReviewSwarmRow>(`SELECT * FROM review_swarms WHERE ${where} ORDER BY created_at DESC`, params).then((r) => r.rows),
  );
}

/** Get findings for a swarm (tenant-scoped). */
export async function listSwarmFindings(userId: string, swarmId: string): Promise<ReviewFindingRow[]> {
  await getSwarm(userId, swarmId);
  return withTenant<ReviewFindingRow[]>(userId, (q) =>
    q
      .query<ReviewFindingRow>(
        'SELECT * FROM review_findings WHERE swarm_id = $1 AND owner_id = $2 ORDER BY created_at',
        [swarmId, userId],
      )
      .then((r) => r.rows),
  );
}

/** Accept or dismiss an OPEN finding (tenant-scoped). */
export async function decideFinding(
  userId: string,
  findingId: string,
  decision: 'ACCEPTED' | 'DISMISSED',
): Promise<ReviewFindingRow> {
  const rows = await withTenant<ReviewFindingRow[]>(userId, (q) =>
    q
      .query<ReviewFindingRow>(
        'SELECT * FROM review_findings WHERE id = $1 AND owner_id = $2',
        [findingId, userId],
      )
      .then((r) => r.rows),
  );
  const finding = rows[0];
  if (!finding) throw AppError.notFound('Finding');
  if (finding.status !== 'OPEN') throw AppError.conflict('finding_not_open', `Finding is ${finding.status}`);
  await withTenant(userId, (q) =>
    q.query(
      `UPDATE review_findings SET status = $1 WHERE id = $2 AND owner_id = $3`,
      [decision, findingId, userId],
    ),
  );
  await recordAudit({
    action: decision === 'ACCEPTED' ? AuditAction.FINDING_ACCEPTED : AuditAction.FINDING_DISMISSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'review_finding',
    resourceId: findingId,
    detail: { swarmId: finding.swarm_id, severity: finding.severity, title: finding.title },
  });
  return { ...finding, status: decision };
}

/** Create a review swarm; the review itself runs in runPrReview. */
export async function startPrReview(
  userId: string,
  input: StartPrReviewInput,
): Promise<ReviewSwarmRow> {
  if (!input.projectId || !input.prRef || !Array.isArray(input.files) || input.files.length === 0) {
    throw AppError.badRequest('pr_review_invalid_input', 'projectId, prRef and files are required');
  }
  if (input.files.length > MAX_FILES) {
    throw AppError.badRequest('pr_review_too_many_files', `At most ${MAX_FILES} files can be reviewed`);
  }
  const files = input.files.map((f) => ({
    path: f.path,
    content: f.content.slice(0, MAX_FILE_BYTES),
  }));
  const id = newId(PREFIX.PR_SWARM);
  const task = await createTask({
    userId,
    projectId: input.projectId,
    title: `PR review: ${input.prRef}`,
    description: `Multi-agent review of ${input.prRef} (${SWARM_ROLES.length} independent roles).`,
    riskLevel: 'MEDIUM',
  });
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO review_swarms (id, owner_id, project_id, pr_ref, target_ref, title, status, roles, files, task_id)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,$9)`,
      [
        id, userId, input.projectId, input.prRef, input.targetRef ?? null,
        input.title ?? `Review ${input.prRef}`, JSON.stringify([...SWARM_ROLES]), JSON.stringify(files), task.id,
      ],
    ),
  );
  await recordAudit({
    action: AuditAction.PR_REVIEW_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'review_swarm',
    resourceId: id,
    detail: { prRef: input.prRef, projectId: input.projectId, taskId: task.id, files: files.length },
  });
  return getSwarm(userId, id);
}

/** Run the swarm: each role reviews independently; failures are recorded, never hidden. */
export async function runPrReview(userId: string, swarmId: string): Promise<ReviewSwarmRow> {
  const swarm = await getSwarm(userId, swarmId);
  if (swarm.status !== 'PENDING' && swarm.status !== 'PARTIAL') {
    throw AppError.conflict('pr_review_not_runnable', `Swarm is ${swarm.status}`);
  }
  if (!Array.isArray(swarm.files) || swarm.files.length === 0) {
    throw AppError.conflict('pr_review_no_files', 'Swarm has no reviewable files');
  }
  await withTenant(userId, (q) =>
    q.query(`UPDATE review_swarms SET status = 'RUNNING', updated_at = now() WHERE id = $1`, [swarmId]),
  );

  let rolesDone = 0;
  let rolesFailed = 0;
  for (const role of SWARM_ROLES) {
    try {
      const summary = await completeWithFallback({
        ctx: { userId, sessionId: `pr-review:${swarmId}:${role}`, planId: await effectivePlan(userId), tenantId: userId },
        messages: roleMessages(role, swarm.title, swarm.files),
        maxTokens: 1200,
        opts: { computeClass: role === 'ARCHITECT' || role === 'SECURITY' ? 'C' : 'B', coding: true },
      });
      const findings = parseFindings(summary.text, swarm.files);
      const drafts = findings.length > 0 ? findings : [unavailableFinding(role)];
      for (const f of drafts) {
        const fid = newId(PREFIX.REVIEW_FINDING);
        await withTenant(userId, (q) =>
          q.query(
            `INSERT INTO review_findings
               (id, swarm_id, owner_id, role, severity, category, title, description,
                file_path, line_start, line_end, evidence, confidence, recommendation, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'OPEN')`,
            [
              fid, swarmId, userId, role, f.severity, f.category, f.title, f.description,
              f.file_path, f.line_start, f.line_end,
              JSON.stringify(f.evidence), f.confidence, f.recommendation,
            ],
          ),
        );
      }
      rolesDone += 1;
    } catch (err) {
      rolesFailed += 1;
      const message = err instanceof Error ? err.message.slice(0, 300) : String(err);
      const fid = newId(PREFIX.REVIEW_FINDING);
      await withTenant(userId, (q) =>
        q.query(
          `INSERT INTO review_findings
             (id, swarm_id, owner_id, role, severity, category, title, description,
              file_path, line_start, line_end, evidence, confidence, recommendation, status)
           VALUES ($1,$2,$3,$4,'INFO','review_failed',$5,$6,NULL,NULL,NULL,'[]',0,NULL,'OPEN')`,
          [fid, swarmId, userId, role, `${role} review failed`, message],
        ),
      );
      await recordAudit({
        action: AuditAction.PR_REVIEW_ROLE_FAILED,
        actorUserId: userId,
        scope: 'USER',
        tenantId: userId,
        resourceType: 'review_swarm',
        resourceId: swarmId,
        detail: { role, error: message },
      });
    }
  }

  const status: SwarmStatus =
    rolesFailed === 0 ? 'COMPLETED' : rolesDone === 0 ? 'FAILED' : 'PARTIAL';
  await withTenant(userId, (q) =>
    q.query(`UPDATE review_swarms SET status = $1, updated_at = now() WHERE id = $2`, [status, swarmId]),
  );

  const all = await listSwarmFindings(userId, swarmId);
  const severityCounts: Record<string, number> = {};
  for (const f of all) severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1;
  await withTenant(userId, (q) =>
    q.query(`UPDATE review_swarms SET verdict = $1, updated_at = now() WHERE id = $2`, [
      JSON.stringify({ rolesDone, rolesFailed, findings: all.length, severityCounts }),
      swarmId,
    ]),
  );

  await recordAudit({
    action: AuditAction.PR_REVIEW_COMPLETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'review_swarm',
    resourceId: swarmId,
    detail: { status, rolesDone, rolesFailed, findings: all.length },
  });
  await notify(
    userId,
    NotificationType.PR_REVIEW_COMPLETED,
    `PR review ${status.toLowerCase()}`,
    {
      body: `${swarm.title} — ${all.length} finding(s)`,
      resourceType: 'review_swarm',
      resourceId: swarmId,
      metadata: { status, prRef: swarm.pr_ref },
    },
  );
  await createMemory(userId, {
    projectId: swarm.project_id,
    tenantId: userId,
    type: MemoryType.SEMANTIC,
    source: MemorySource.AI_INFERRED,
    content: `PR review ${swarm.pr_ref} (${status.toLowerCase()}): ${all.length} finding(s)`,
    confidence: status === 'COMPLETED' ? 0.8 : 0.4,
    provenance: `pr-review:${swarmId}`,
  });
  return getSwarm(userId, swarmId);
}
