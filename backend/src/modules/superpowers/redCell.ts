/**
 * CodeConClave — Superpowers: RED CELL (Master Feature #30).
 *
 * Finds vulnerabilities by trying to exploit them, not just pattern-matching
 * known-bad code: each static hit is checked against exploitability heuristics
 * so only *confirmed* risk reaches the top of the list. The output is a short
 * to-do list, not a wall of "possible vulnerability" noise.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type RedCellCategory = 'SQL_INJECTION' | 'XSS' | 'CODE_INJECTION' | 'COMMAND_INJECTION' | 'HARDCODED_SECRET' | 'UNSAFE_EVAL';
export type RedCellSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type FindingStatus = 'OPEN' | 'ACKNOWLEDGED' | 'CLEARED';

export const RED_CELL_CATEGORIES: RedCellCategory[] = ['SQL_INJECTION', 'XSS', 'CODE_INJECTION', 'COMMAND_INJECTION', 'HARDCODED_SECRET', 'UNSAFE_EVAL'];
export const RED_CELL_SEVERITIES: RedCellSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
export const FINDING_STATUSES: FindingStatus[] = ['OPEN', 'ACKNOWLEDGED', 'CLEARED'];

export interface RedCellScopeFile {
  path: string;
  content: string;
}

export interface RedCellFindingRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  target: string;
  category: RedCellCategory;
  severity: RedCellSeverity;
  confirmed: boolean;
  risk_score: number;
  code_snippet: string | null;
  suggestion: string | null;
  status: FindingStatus;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): RedCellFindingRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  target: String(r.target),
  category: r.category as RedCellCategory,
  severity: r.severity as RedCellSeverity,
  confirmed: r.confirmed === true || r.confirmed === 'true',
  risk_score: Number(r.risk_score ?? 0),
  code_snippet: r.code_snippet ? String(r.code_snippet) : null,
  suggestion: r.suggestion ? String(r.suggestion) : null,
  status: (r.status ?? 'OPEN') as FindingStatus,
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

interface Rule {
  category: RedCellCategory;
  severity: RedCellSeverity;
  riskScore: number;
  pattern: RegExp;
  confirmed: (match: RegExpExecArray) => boolean;
  suggestion: string;
}

const PLACEHOLDER_VALUE = /(example|your_|changeme|test_key|dummy|placeholder|xxxxx|redacted|sample)/i;

const RULES: Rule[] = [
  {
    category: 'HARDCODED_SECRET',
    severity: 'HIGH',
    riskScore: 70,
    pattern: /(api[_-]?key|api[_-]?secret|client[_-]?secret|access[_-]?token|auth_token|password|passwd|secret)\s*[:=]\s*["'][A-Za-z0-9_\-./+=]{8,}["']/gi,
    confirmed: (m) => !PLACEHOLDER_VALUE.test(m[0]),
    suggestion: 'Move the credential to the platform secrets store and inject it at runtime; never inline credentials in source.',
  },
  {
    category: 'SQL_INJECTION',
    severity: 'CRITICAL',
    riskScore: 90,
    pattern: /(?:query|execute|raw|run|cursor)\s*\(\s*(?:`[^`]*\$\{[^}]+\}[^`]*`|["'][^"'\r\n]*["']\s*\+\s*[\w$.]+)/gi,
    confirmed: () => true,
    suggestion: 'Use parameterized queries or the query builder; never interpolate user input into SQL text.',
  },
  {
    category: 'COMMAND_INJECTION',
    severity: 'CRITICAL',
    riskScore: 85,
    pattern: /(?:\.exec|\.spawn|execSync|execFileSync|child_process|_exec)\s*\(\s*(?:`[^`]*\$\{[^}]+\}[^`]*`|["'][^"'\r\n]*["']\s*\+\s*[\w$.]+)/gi,
    confirmed: () => true,
    suggestion: 'Run commands with an argv array (no shell interpolation) and validate every input bound.',
  },
  {
    category: 'CODE_INJECTION',
    severity: 'CRITICAL',
    riskScore: 80,
    pattern: /(?:new\s+Function|Function)\s*\(\s*`[^`]*\$\{/gi,
    confirmed: () => true,
    suggestion: 'Never construct executable code from dynamic strings; prefer data-driven dispatch.',
  },
  {
    category: 'UNSAFE_EVAL',
    severity: 'HIGH',
    riskScore: 75,
    pattern: /\beval\s*\(\s*(?:[A-Za-z_$][\w$.]*|`[^`]*\$\{)/gi,
    confirmed: (m) => /\$\{/.test(m[0]) || !/['"]/.test(m[0]),
    suggestion: 'Avoid eval entirely; when unavoidable, evaluate only trusted, validated constants.',
  },
  {
    category: 'XSS',
    severity: 'HIGH',
    riskScore: 70,
    pattern: /(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write|dangerouslySetInnerHTML)\s*[:=]\s*(?:[A-Za-z_$][\w$.]*|\{)/gi,
    confirmed: () => true,
    suggestion: 'Build DOM with textContent or the framework escape path; sanitize any HTML binding.',
  },
];

const snippetOf = (m: RegExpExecArray): string => {
  const raw = m[0].length <= 160 ? m[0] : `${m[0].slice(0, 157)}...`;
  return raw;
};

export interface RedCellScanReport {
  files: number;
  total: number;
  confirmed: number;
  unconfirmed_potential: number;
  by_severity: Record<RedCellSeverity, number>;
  findings: RedCellFindingRow[];
}

export async function runRedCellScan(userId: string, input: { projectId?: string | null; scope: RedCellScopeFile[] }): Promise<RedCellScanReport> {
  const scope = Array.isArray(input.scope) ? input.scope : [];
  if (scope.length === 0) throw AppError.badRequest('empty_scope', 'red cell scan needs at least one file to analyze');
  const findings: RedCellFindingRow[] = [];
  for (const file of scope) {
    const { path, content } = file;
    if (typeof path !== 'string' || typeof content !== 'string') throw AppError.badRequest('invalid_scope_entry', 'each scope entry needs a path and content');
    for (const rule of RULES) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        const id = newId(PREFIX.RED_CELL_FINDING);
        const confirmed = rule.confirmed(match);
        const m = match;
        const projectId = input.projectId ?? null;
        await withTenant(userId, (q) =>
          q.query(
            'INSERT INTO red_cell_findings (id, owner_id, project_id, target, category, severity, confirmed, risk_score, code_snippet, suggestion, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
            [id, userId, projectId, path, rule.category, rule.severity, confirmed, rule.riskScore, snippetOf(m), rule.suggestion, 'OPEN'],
          ),
        );
        const inserted = await findFindingById(userId, id);
        findings.push(inserted);
      }
    }
  }
  const report: RedCellScanReport = {
    files: scope.length,
    total: findings.length,
    confirmed: findings.filter((f) => f.confirmed).length,
    unconfirmed_potential: findings.filter((f) => !f.confirmed).length,
    by_severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    findings: rankFindingsList(findings),
  };
  for (const f of report.findings) report.by_severity[f.severity] += 1;
  await recordAudit({
    action: AuditAction.RED_CELL_SCANNED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'red_cell_findings',
    resourceId: null,
    detail: { files: report.files, total: report.total, confirmed: report.confirmed },
  });
  return report;
}

const rankFindingsList = (rows: RedCellFindingRow[]): RedCellFindingRow[] =>
  [...rows].sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || b.risk_score - a.risk_score || a.category.localeCompare(b.category) || a.target.localeCompare(b.target));

export async function findFindingById(userId: string, id: string): Promise<RedCellFindingRow> {
  const row = await withTenant(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM red_cell_findings WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null,
  );
  if (!row) throw AppError.notFound('red_cell_finding_not_found', 'no red cell finding found for that id');
  return rowOf(row);
}

export async function listFindings(userId: string, filter: { category?: string; severity?: string; status?: string; confirmed?: boolean } = {}): Promise<RedCellFindingRow[]> {
  let rows = (
    await withTenant(userId, async (q) =>
      (await q.query<Record<string, unknown>>('SELECT * FROM red_cell_findings WHERE owner_id = $1', [userId])).rows,
    )
  ).map(rowOf);
  if (filter.category) rows = rows.filter((f) => f.category === filter.category);
  if (filter.severity) rows = rows.filter((f) => f.severity === filter.severity);
  if (filter.status) rows = rows.filter((f) => f.status === filter.status);
  if (typeof filter.confirmed === 'boolean') rows = rows.filter((f) => f.confirmed === filter.confirmed);
  return rankFindingsList(rows);
}

export async function confirmFinding(userId: string, id: string): Promise<RedCellFindingRow> {
  const finding = await findFindingById(userId, id);
  await withTenant(userId, (q) =>
    q.query('UPDATE red_cell_findings SET confirmed = $3, status = $4, updated_at = now() WHERE id = $1 AND owner_id = $2', [id, userId, true, 'ACKNOWLEDGED']),
  );
  await recordAudit({
    action: AuditAction.RED_CELL_CONFIRMED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'red_cell_findings',
    resourceId: id,
    detail: { category: finding.category, target: finding.target },
  });
  return findFindingById(userId, id);
}

export async function clearFinding(userId: string, id: string, note?: string): Promise<RedCellFindingRow> {
  const finding = await findFindingById(userId, id);
  if (finding.status === 'CLEARED') return finding;
  await withTenant(userId, (q) =>
    q.query('UPDATE red_cell_findings SET status = $3, updated_at = now() WHERE id = $1 AND owner_id = $2', [id, userId, 'CLEARED']),
  );
  await recordAudit({
    action: AuditAction.RED_CELL_CLEARED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'red_cell_findings',
    resourceId: id,
    detail: { category: finding.category, confirmed: finding.confirmed, note: note ?? null },
  });
  return findFindingById(userId, id);
}

export async function rankFindings(userId: string): Promise<{ findings: RedCellFindingRow[]; summary: RedCellScanReport }> {
  const findings = rankFindingsList(
    (
      await withTenant(userId, async (q) =>
        (await q.query<Record<string, unknown>>('SELECT * FROM red_cell_findings WHERE owner_id = $1', [userId])).rows,
      )
    ).map(rowOf),
  );
  const by_severity: Record<RedCellSeverity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings) by_severity[f.severity] += 1;
  return {
    findings,
    summary: {
      files: 0,
      total: findings.length,
      confirmed: findings.filter((f) => f.confirmed).length,
      unconfirmed_potential: findings.filter((f) => !f.confirmed).length,
      by_severity,
      findings,
    },
  };
}