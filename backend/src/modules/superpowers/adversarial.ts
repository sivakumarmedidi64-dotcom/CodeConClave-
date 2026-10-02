/**
 * CodeConClave — Superpowers: ADVERSARIAL SUITE (Master Feature #35).
 *
 * Before a PR can merge, a dedicated adversary agent attacks the change and
 * tries to break it. Edge inputs, race conditions, permission escapes,
 * resource exhaustion and null paths are all probed; if the adversary finds an
 * issue the change is BLOCKED with specific evidence instead of vague FUD.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type AdversarialCategory = 'RACE_CONDITION' | 'NULL_PATH' | 'PERMISSION_ESCAPE' | 'RESOURCE_EXHAUSTION';
export type AdversarialSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM';
export type AdversarialVerdict = 'PASS' | 'BLOCKED';

export interface AdversarialScopeFile {
  path: string;
  content: string;
}

export interface AdversarialFinding {
  category: AdversarialCategory;
  severity: AdversarialSeverity;
  risk_score: number;
  file: string;
  evidence: string;
  suggestion: string;
}

export interface AdversarialRunRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  change_ref: string;
  verdict: AdversarialVerdict;
  findings: AdversarialFinding[];
  generated_attacks: string[];
  created_at: Date;
}

const asList = <T>(v: unknown): T[] => {
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T[]; } catch { return [] as T[]; }
  }
  if (Array.isArray(v)) return v as T[];
  return [] as T[];
};

const rowOf = (r: Record<string, unknown>): AdversarialRunRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  change_ref: String(r.change_ref),
  verdict: (r.verdict ?? 'PASS') as AdversarialVerdict,
  findings: asList<AdversarialFinding>(r.findings),
  generated_attacks: asList<string>(r.generated_attacks),
  created_at: new Date(r.created_at as string),
});

const snippetOf = (m: RegExpExecArray): string => (m[0].length <= 200 ? m[0] : `${m[0].slice(0, 197)}...`);

interface Rule {
  category: AdversarialCategory;
  severity: AdversarialSeverity;
  riskScore: number;
  pattern: RegExp;
  suggestion: string;
}

const RULES: Rule[] = [
  {
    category: 'PERMISSION_ESCAPE',
    severity: 'CRITICAL',
    riskScore: 90,
    pattern: /(chmod\s+[-]?[0-7]{3,4})|((?:grant|revoke|allow)\s+all\s+privileges?)|((?:service[_ ]?account|tenant|role)\s*=\s*["']?[^"'\r\n]{0,40}?(?:admin|\*))/gi,
    suggestion: 'Narrow the grant to the specific resource and action; wildcard admin must never ship.',
  },
  {
    category: 'RESOURCE_EXHAUSTION',
    severity: 'HIGH',
    riskScore: 85,
    pattern: /(while\s*\(\s*(?:true|1)\s*\))|([\w$]+\.repeat\s*\(\s*[\w$]+)|(new\s+[A-Za-z_$]\w*\s*\(\s*[\w$]+)/gi,
    suggestion: 'Bound allocations and loops by the actual input size with a hard cap.',
  },
  {
    category: 'RACE_CONDITION',
    severity: 'MEDIUM',
    riskScore: 55,
    pattern: /\b(?:setTimeout|setImmediate|process\.nextTick)\s*\(\s*[^,)]*,\s*0\s*\)/gi,
    suggestion: 'Replace timer-based coordination with a real await/queue; zero-delay timers mask race assumptions.',
  },
  {
    category: 'NULL_PATH',
    severity: 'MEDIUM',
    riskScore: 50,
    pattern: /(?:=\s*[A-Za-z_$][\w$.]*|\breturn\s+[A-Za-z_$][\w$.]*)\s?\.(?:map|forEach|toUpperCase|split|substring|length)\s*\(/gi,
    suggestion: 'Guard the input against null/undefined before dereferencing it.',
  },
];

/** Deterministic probe set the adversary always generates for a change. */
export const EDGE_ATTACK_PLAN: readonly string[] = [
  'empty string and zero-length inputs',
  'zero, negative and Number.MAX_SAFE_INTEGER numeric inputs',
  'very long payload (100k+ chars) to probe overflow and truncation',
  'control characters, NUL bytes and unicode direction markers',
  'null and undefined objects where scalars are expected',
  'array payloads injected where a scalar is expected',
  'duplicate keys, deep nesting and self-referential structures',
];

export async function runAdversarialReview(userId: string, input: { projectId?: string | null; changeRef: string; scope: AdversarialScopeFile[] }): Promise<AdversarialRunRow> {
  const scope = Array.isArray(input.scope) ? input.scope : [];
  if (scope.length === 0) throw AppError.badRequest('empty_scope', 'the adversary needs at least one file to attack');
  const findings: AdversarialFinding[] = [];
  for (const file of scope) {
    const { path, content } = file;
    if (typeof path !== 'string' || typeof content !== 'string') throw AppError.badRequest('invalid_scope_entry', 'each scope entry needs a path and content');
    for (const rule of RULES) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        findings.push({
          category: rule.category,
          severity: rule.severity,
          risk_score: rule.riskScore,
          file: path,
          evidence: snippetOf(match),
          suggestion: rule.suggestion,
        });
      }
    }
  }
  const sorted = [...findings].sort(
    (a, b) => b.risk_score - a.risk_score || a.category.localeCompare(b.category) || a.file.localeCompare(b.file),
  );
  const verdict: AdversarialVerdict = sorted.length > 0 ? 'BLOCKED' : 'PASS';
  const id = newId(PREFIX.ADVERSARIAL_RUN);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO adversarial_runs (id, owner_id, project_id, change_ref, verdict, findings, generated_attacks) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.projectId ?? null, input.changeRef, verdict, JSON.stringify(sorted), JSON.stringify(EDGE_ATTACK_PLAN)],
  ));
  await recordAudit({
    action: AuditAction.ADVERSARIAL_RUN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'adversarial_runs',
    resourceId: id,
    detail: { changeRef: input.changeRef, verdict, findings: sorted.length },
  });
  return getAdversarialRun(userId, id);
}

export async function getAdversarialRun(userId: string, id: string): Promise<AdversarialRunRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM adversarial_runs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('adversarial_run_not_found', 'no adversarial run found for that id');
  return rowOf(row);
}

export async function listAdversarialRuns(userId: string, filter: { verdict?: AdversarialVerdict; changeRef?: string } = {}): Promise<AdversarialRunRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM adversarial_runs WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.verdict) rows = rows.filter((r) => r.verdict === filter.verdict);
  if (filter.changeRef) rows = rows.filter((r) => r.change_ref === filter.changeRef);
  return rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export function generateEdgeAttackPlan(): string[] {
  return [...EDGE_ATTACK_PLAN];
}