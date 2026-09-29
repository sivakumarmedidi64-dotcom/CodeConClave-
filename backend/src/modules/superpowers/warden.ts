/**
 * CodeConClave — Superpowers: WARDEN (Master Feature #29).
 *
 * Architectural drift is blocked at proposal time, not cleaned up later.
 * Policies encode module boundaries as:
 *
 *   - forbidden_imports: glob-ish import specifier patterns that a module in
 *     this scope may NEVER import (e.g. "ui -> db" boundary: forbid any
 *     `from '@app/db'` inside UI files).
 *   - required_imports: patterns that must be present (e.g. all routes must
 *     import the auth middleware).
 *
 * checkChangeDiff parses real import/require statements out of a proposed
 * change (added lines only) and reports every violation against the matching
 * policy. Deterministic — no AI, no guesswork: policy enforcement is exact.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface WardenPolicyInput {
  name: string;
  description?: string;
  projectId?: string | null;
  forbiddenImports?: string[];
  requiredImports?: string[];
  enabled?: boolean;
}

export interface WardenPolicyRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  name: string;
  description: string | null;
  forbidden_imports: string[];
  required_imports: string[];
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface WardenViolation {
  policyId: string;
  policy: string;
  rule: 'forbidden' | 'required';
  pattern: string;
  importSpecifier: string | null;
  detail: string;
}

export interface WardenCheckResult {
  passed: boolean;
  violations: WardenViolation[];
}

function rowOf(r: Record<string, unknown>): WardenPolicyRow {
  return {
    id: String(r.id),
    owner_id: String(r.owner_id),
    project_id: r.project_id === null ? null : String(r.project_id),
    name: String(r.name),
    description: r.description === null ? null : String(r.description),
    forbidden_imports: Array.isArray(r.forbidden_imports) ? r.forbidden_imports.map(String) : [],
    required_imports: Array.isArray(r.required_imports) ? r.required_imports.map(String) : [],
    enabled: r.enabled === true || r.enabled === 'true',
    created_at: new Date(String(r.created_at)),
    updated_at: new Date(String(r.updated_at)),
  };
}

export async function createWardenPolicy(userId: string, input: WardenPolicyInput): Promise<WardenPolicyRow> {
  const name = (input.name ?? '').trim();
  if (!name) throw AppError.badRequest('policy_name_required', 'A policy name is required');
  const forbidden = (input.forbiddenImports ?? []).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 50);
  const required = (input.requiredImports ?? []).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 50);
  if (!forbidden.length && !required.length) {
    throw AppError.badRequest('policy_empty', 'A policy needs at least one forbidden or required import pattern');
  }
  const id = newId(PREFIX.WARDEN_POLICY);
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO warden_policies (id, owner_id, project_id, name, description, forbidden_imports, required_imports, enabled)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
      [
        id, userId, input.projectId ?? null, name, input.description?.trim()?.slice(0, 500) ?? null,
        JSON.stringify(forbidden), JSON.stringify(required), input.enabled !== false,
      ],
    ),
  );
  await recordAudit({
    action: AuditAction.WARDEN_POLICY_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'warden_policies',
    resourceId: id,
    detail: { name, forbidden: forbidden.length, required: required.length },
  });
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM warden_policies WHERE id = $1', [id])).rows,
  );
  return rowOf(rows[0]!);
}

export async function listWardenPolicies(userId: string, opts: { projectId?: string } = {}): Promise<WardenPolicyRow[]> {
  if (opts.projectId) {
    const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
      (await q.query<Record<string, unknown>>(
        'SELECT * FROM warden_policies WHERE owner_id = $1 AND project_id = $2 ORDER BY created_at DESC',
        [userId, opts.projectId],
      )).rows,
    );
    return rows.map(rowOf);
  }
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM warden_policies WHERE owner_id = $1 ORDER BY created_at DESC', [userId])).rows,
  );
  return rows.map(rowOf);
}

export async function updateWardenPolicy(
  userId: string,
  policyId: string,
  patch: { description?: string; forbiddenImports?: string[]; requiredImports?: string[]; enabled?: boolean },
): Promise<WardenPolicyRow> {
  const existing = await getWardenPolicy(userId, policyId);
  const forbidden = patch.forbiddenImports !== undefined
    ? patch.forbiddenImports.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 50)
    : existing.forbidden_imports;
  const required = patch.requiredImports !== undefined
    ? patch.requiredImports.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 50)
    : existing.required_imports;
  const description = patch.description !== undefined ? patch.description.trim().slice(0, 500) || null : existing.description;
  const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled;
  await withTenant(userId, (q) =>
    q.query(
      `UPDATE warden_policies
         SET description = $3, forbidden_imports = $4::jsonb, required_imports = $5::jsonb, enabled = $6, updated_at = now()
       WHERE id = $1 AND owner_id = $2`,
      [policyId, userId, description, JSON.stringify(forbidden), JSON.stringify(required), enabled],
    ),
  );
  await recordAudit({
    action: AuditAction.WARDEN_POLICY_UPDATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'warden_policies',
    resourceId: policyId,
  });
  return getWardenPolicy(userId, policyId);
}

export async function getWardenPolicy(userId: string, policyId: string): Promise<WardenPolicyRow> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      'SELECT * FROM warden_policies WHERE id = $1 AND owner_id = $2',
      [policyId, userId],
    )).rows,
  );
  if (!rows[0]) throw AppError.notFound('Warden policy');
  return rowOf(rows[0]);
}

export async function deleteWardenPolicy(userId: string, policyId: string): Promise<void> {
  const result = await withTenant(userId, (q) =>
    q.query('DELETE FROM warden_policies WHERE id = $1 AND owner_id = $2', [policyId, userId]),
  );
  if ((result.rowCount ?? 0) === 0) throw AppError.notFound('Warden policy');
  await recordAudit({
    action: AuditAction.WARDEN_POLICY_DELETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'warden_policies',
    resourceId: policyId,
  });
}

/** Strip quotes from the specifier and normalize to a bare module path. */
export function bareSpecifier(spec: string): string {
  let s = spec.trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1);
  return s.replace(/^\.{1,2}\//, '').replace(/\/index$/, '');
}

/** Extract every import specifier used by a file: ESM `import` and CJS `require`. */
export function extractImports(code: string): string[] {
  const out = new Set<string>();
  const esmImportRe = /\bimport\s+(?:(?:[^'"]*?\bfrom\s+)?['"])([^'"]+)(['"])/g;
  const requireRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  const dynamicImportRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [esmImportRe, requireRe, dynamicImportRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      if (m[1]?.trim()) out.add(m[1].trim());
    }
  }
  return [...out];
}

export function matchesPattern(specifier: string, pattern: string): boolean {
  const spec = bareSpecifier(specifier);
  const pat = bareSpecifier(pattern);
  if (pat === spec) return true;
  if (pat.includes('*')) {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let rx = '^';
    for (let i = 0; i < pat.length; i++) {
      const ch = pat[i]!;
      if (ch === '*') {
        if (pat[i + 1] === '*') { rx += '.*'; i += 1; } // '**' crosses / boundaries
        else rx += '.+';                                  // '*' spans nested sub-paths
      } else {
        rx += esc(ch);
      }
    }
    return new RegExp(`${rx}$`).test(spec);
  }
  return spec === pat || spec.startsWith(`${pat}/`);
}

/** Parse added lines of a diff (context: only `+` lines are the change). */
export function addedLines(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
}

/**
 * WARDEN CHECK: given a proposed change (diff) and the policies in scope,
 * return every policy violation. A forbidden import that appears, or a
 * required import that is missing, is a violation -> the change is BLOCKED
 * (passed=false). Deterministic and explicit.
 */
export async function checkChangeAgainstPolicies(userId: string, diff: string, opts: { projectId?: string } = {}): Promise<WardenCheckResult> {
  const policies = await listWardenPolicies(userId, opts);
  const enabled = policies.filter((p) => p.enabled);
  const added = addedLines(diff);
  const imports = added.flatMap((line) => extractImports(line));
  const violations: WardenViolation[] = [];

  for (const p of enabled) {
    for (const pat of p.forbidden_imports) {
      const hit = imports.find((i) => matchesPattern(i, pat));
      if (hit) {
        violations.push({
          policyId: p.id, policy: p.name, rule: 'forbidden', pattern: pat, importSpecifier: hit,
          detail: `This change imports "${hit}" which policy "${p.name}" forbids (boundary: ${pat}).`,
        });
      }
    }
    if (p.required_imports.length > 0) {
      for (const pat of p.required_imports) {
        if (!imports.some((i) => matchesPattern(i, pat))) {
          violations.push({
            policyId: p.id, policy: p.name, rule: 'required', pattern: pat, importSpecifier: null,
            detail: `This change is missing required import matching "${pat}" enforced by policy "${p.name}".`,
          });
        }
      }
    }
  }

  await recordAudit({
    action: AuditAction.WARDEN_CHANGE_CHECKED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'warden_policies',
    resourceId: null,
    detail: { importedLines: imports.length, violations: violations.length, passed: violations.length === 0 },
  });
  return { passed: violations.length === 0, violations };
}