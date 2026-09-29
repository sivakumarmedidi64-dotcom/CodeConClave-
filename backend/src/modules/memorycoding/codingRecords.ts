/**
 * CodeConClave — PKG-23 Memory-Powered Coding — isolated record persistence.
 * Shared, owner+project scoped DB access for the additive developer records
 * (dev_preferences, dev_patterns, dev_bug_incidents, memorycoding_links).
 *
 * Isolation is ALWAYS enforced in the WHERE clause: an id alone is never enough;
 * owner_id (and project_id where applicable) must match the caller. Content is
 * redacted via secretGuard before persistence so secrets are never stored.
 *
 * This is NOT a second memory database — it stores focused developer records
 * ON TOP of the existing `memories` system, which is reused unchanged.
 */
import { withTenant } from '../../shared/db.js';
import { newId } from '../../shared/ids.js';
import { redactSecrets } from '../secretGuard/service.js';

export type PrefClassification = 'EXPLICIT' | 'INFERRED' | 'UNKNOWN';
export type PatternStatus = 'ACTIVE' | 'SUPERSEDED' | 'REJECTED';
export type BugStatus = 'OPEN' | 'FIXED' | 'SUPERSEDED';
export type MemoryLinkKind =
  | 'DEPLOYMENT_ROLLBACK'
  | 'ROLLBACK_TARGET'
  | 'DEPLOYMENT_FIX'
  | 'RUNTIME_FIX'
  | 'TEST_RELATED'
  | 'BUG_RELATED';

export interface PrefRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  category: string;
  key: string;
  value: Record<string, unknown>;
  classification: PrefClassification;
  confidence: number;
  source: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PatternRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  name: string;
  description: string;
  category: string | null;
  evidence_count: number;
  confirm_count: number;
  reject_count: number;
  confidence: number;
  source: string;
  status: PatternStatus;
  created_at: Date;
  updated_at: Date;
}

export interface BugIncidentRow {
  id: string;
  owner_id: string;
  project_id: string;
  title: string;
  symptom_key: string;
  first_seen_at: Date;
  last_seen_at: Date;
  occurrences: number;
  status: BugStatus;
  diagnosis: string | null;
  fix_summary: string | null;
  test_ref: string | null;
  deploy_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryLinkRow {
  id: string;
  owner_id: string;
  project_id: string;
  kind: MemoryLinkKind;
  from_ref: string;
  to_ref: string;
  evidence: Record<string, unknown> | null;
  created_at: Date;
}

// ------------------------------------------------------------------ preferences

export async function upsertPreference(
  ownerId: string,
  input: {
    projectId?: string | null;
    category: string;
    key: string;
    value: Record<string, unknown>;
    classification: PrefClassification;
    confidence?: number;
    source?: string | null;
  },
): Promise<PrefRow> {
  const id = input.projectId ? newId('pmcp') : newId('pmcs');
  const read = await withTenant<{ rows: PrefRow[] }>(ownerId, async (q) =>
    q.query<PrefRow>(
      `SELECT * FROM dev_preferences WHERE owner_id = $1 AND project_id IS NOT DISTINCT FROM $2 AND category = $3 AND key = $4`,
      [ownerId, input.projectId ?? null, input.category, input.key],
    ),
  );
  const existing = read.rows[0];
  const confidence = input.confidence ?? (input.classification === 'EXPLICIT' ? 0.9 : 0.5);
  const value = JSON.stringify(input.value);
  const source = input.source?.slice(0, 400) ?? null;
  if (existing) {
    await withTenant(ownerId, (q) =>
      q.query(
        `UPDATE dev_preferences SET value = $1::jsonb, classification = $2, confidence = $3, source = $4, updated_at = now()
         WHERE id = $5`,
        [value, input.classification, confidence, source, existing.id],
      ),
    );
    const after = await withTenant<{ rows: PrefRow[] }>(ownerId, (q) => q.query<PrefRow>('SELECT * FROM dev_preferences WHERE id = $1', [existing.id]));
    return after.rows[0]!;
  }
  await withTenant(ownerId, (q) =>
    q.query(
      `INSERT INTO dev_preferences (id, owner_id, project_id, category, key, value, classification, confidence, source)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
      [id, ownerId, input.projectId ?? null, input.category, input.key, value, input.classification, confidence, source],
    ),
  );
  const after = await withTenant<{ rows: PrefRow[] }>(ownerId, (q) => q.query<PrefRow>('SELECT * FROM dev_preferences WHERE id = $1', [id]));
  return after.rows[0]!;
}

export async function listPreferences(ownerId: string, projectId?: string | null): Promise<PrefRow[]> {
  const rows = await withTenant<{ rows: PrefRow[] }>(ownerId, (q) =>
    q.query<PrefRow>(
      `SELECT * FROM dev_preferences WHERE owner_id = $1 ${projectId ? 'AND project_id = $2' : ''} ORDER BY updated_at DESC LIMIT 200`,
      projectId ? [ownerId, projectId] : [ownerId],
    ),
  );
  return rows.rows;
}

export async function deletePreference(ownerId: string, prefId: string): Promise<void> {
  await withTenant(ownerId, (q) => q.query('DELETE FROM dev_preferences WHERE id = $1 AND owner_id = $2', [prefId, ownerId]));
}

export async function getPreference(ownerId: string, prefId: string): Promise<PrefRow | null> {
  const rows = await withTenant<{ rows: PrefRow[] }>(ownerId, (q) =>
    q.query<PrefRow>('SELECT * FROM dev_preferences WHERE id = $1 AND owner_id = $2', [prefId, ownerId]),
  );
  return rows.rows[0] ?? null;
}

// ------------------------------------------------------------------ patterns

export async function upsertPattern(
  ownerId: string,
  input: {
    projectId?: string | null;
    name: string;
    description: string;
    category?: string | null;
    evidenceCount?: number;
    confidence?: number;
    source?: string;
  },
): Promise<PatternRow> {
  const name = input.name.trim().slice(0, 200);
  const description = redactSecrets(input.description.trim().slice(0, 4000));
  if (!name || !description) throw new Error('pattern_required');
  const read = await withTenant<{ rows: PatternRow[] }>(ownerId, (q) =>
    q.query<PatternRow>(
      `SELECT * FROM dev_patterns WHERE owner_id = $1 AND project_id IS NOT DISTINCT FROM $2 AND name = $3 AND status = 'ACTIVE'`,
      [ownerId, input.projectId ?? null, name],
    ),
  );
  const existing = read.rows[0];
  if (existing) {
    const evidence = input.evidenceCount ?? existing.evidence_count + 1;
    const confidence = patternConfidence(evidence, existing.confirm_count, existing.reject_count);
    await withTenant(ownerId, (q) =>
      q.query(
        `UPDATE dev_patterns SET description = $1, evidence_count = $2, confidence = $3, source = $4, updated_at = now() WHERE id = $5`,
        [description, evidence, confidence, input.source ?? existing.source, existing.id],
      ),
    );
    const after = await withTenant<{ rows: PatternRow[] }>(ownerId, (q) => q.query<PatternRow>('SELECT * FROM dev_patterns WHERE id = $1', [existing.id]));
    return after.rows[0]!;
  }
  const evidence = input.evidenceCount ?? 1;
  const id = input.projectId ? newId('mppp') : newId('mpps');
  await withTenant(ownerId, (q) =>
    q.query(
      `INSERT INTO dev_patterns (id, owner_id, project_id, name, description, category, evidence_count, confidence, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, ownerId, input.projectId ?? null, name, description, input.category?.trim().slice(0, 50) ?? null, evidence,
       patternConfidence(evidence, 0, 0), input.source ?? 'OBSERVED'],
    ),
  );
  const after = await withTenant<{ rows: PatternRow[] }>(ownerId, (q) => q.query<PatternRow>('SELECT * FROM dev_patterns WHERE id = $1', [id]));
  return after.rows[0]!;
}

/** Confidence is evidence-gated; a single observation is NEVER confident. */
export function patternConfidence(evidence: number, confirm = 0, reject = 0): number {
  if (reject >= confirm && reject > 0) return Math.max(0, 0.1 - reject * 0.05);
  if (confirm > 0) return Math.min(0.99, 0.5 + confirm * 0.1 + evidence * 0.04);
  if (evidence >= 5) return Math.min(0.85, 0.4 + evidence * 0.06);
  if (evidence >= 2) return 0.5;
  return 0.2; // single (or zero) observation: low confidence, never a rule
}

export async function bumpPattern(
  ownerId: string,
  patternId: string,
  field: 'confirm' | 'reject',
): Promise<PatternRow | null> {
  const rows = await withTenant<{ rows: PatternRow[] }>(ownerId, (q) =>
    q.query<PatternRow>('SELECT * FROM dev_patterns WHERE id = $1 AND owner_id = $2', [patternId, ownerId]),
  );
  const p = rows.rows[0];
  if (!p) return null;
  const confirm = p.confirm_count + (field === 'confirm' ? 1 : 0);
  const reject = p.reject_count + (field === 'reject' ? 1 : 0);
  const confidence = patternConfidence(p.evidence_count, confirm, reject);
  await withTenant(ownerId, (q) =>
    q.query(
      `UPDATE dev_patterns SET confirm_count = $1, reject_count = $2, confidence = $3,
         status = CASE WHEN $2 > $1 AND $2 >= 2 THEN 'REJECTED' ELSE status END, updated_at = now() WHERE id = $4`,
      [confirm, reject, confidence, p.id],
    ),
  );
  const after = await withTenant<{ rows: PatternRow[] }>(ownerId, (q) => q.query<PatternRow>('SELECT * FROM dev_patterns WHERE id = $1', [p.id]));
  return after.rows[0] ?? null;
}

export async function supersedePattern(ownerId: string, patternId: string): Promise<void> {
  await withTenant(ownerId, (q) =>
    q.query(
      "UPDATE dev_patterns SET status = 'SUPERSEDED', updated_at = now() WHERE id = $1 AND owner_id = $2",
      [patternId, ownerId],
    ),
  );
}

export async function listPatterns(ownerId: string, projectId?: string | null): Promise<PatternRow[]> {
  const rows = await withTenant<{ rows: PatternRow[] }>(ownerId, (q) =>
    q.query<PatternRow>(
      `SELECT * FROM dev_patterns WHERE owner_id = $1 AND status = 'ACTIVE' ${projectId ? 'AND project_id = $2' : ''}
       ORDER BY confidence DESC, evidence_count DESC LIMIT 100`,
      projectId ? [ownerId, projectId] : [ownerId],
    ),
  );
  return rows.rows;
}

// ------------------------------------------------------------------ bug incidents

export async function registerBugOccurrence(
  ownerId: string,
  input: { projectId: string; title: string; symptomKey: string },
): Promise<BugIncidentRow> {
  const title = input.title.trim().slice(0, 200);
  const symptom = input.symptomKey.trim().slice(0, 300);
  const read = await withTenant<{ rows: BugIncidentRow[] }>(ownerId, (q) =>
    q.query<BugIncidentRow>(
      `SELECT * FROM dev_bug_incidents WHERE owner_id = $1 AND project_id = $2 AND symptom_key = $3 AND status = 'OPEN'`,
      [ownerId, input.projectId, symptom],
    ),
  );
  const existing = read.rows[0];
  if (existing) {
    await withTenant(ownerId, (q) =>
      q.query(
        `UPDATE dev_bug_incidents SET occurrences = occurrences + 1, last_seen_at = now(), updated_at = now() WHERE id = $1`,
        [existing.id],
      ),
    );
    const after = await withTenant<{ rows: BugIncidentRow[] }>(ownerId, (q) => q.query<BugIncidentRow>('SELECT * FROM dev_bug_incidents WHERE id = $1', [existing.id]));
    return after.rows[0]!;
  }
  const id = newId('mcbi');
  await withTenant(ownerId, (q) =>
    q.query(
      `INSERT INTO dev_bug_incidents (id, owner_id, project_id, title, symptom_key) VALUES ($1,$2,$3,$4,$5)`,
      [id, ownerId, input.projectId, title, symptom],
    ),
  );
  const after = await withTenant<{ rows: BugIncidentRow[] }>(ownerId, (q) => q.query<BugIncidentRow>('SELECT * FROM dev_bug_incidents WHERE id = $1', [id]));
  return after.rows[0]!;
}

export async function closeBugIncident(
  ownerId: string,
  incidentId: string,
  fix: { diagnosis?: string; fixSummary?: string; testRef?: string; deployRef?: string },
): Promise<BugIncidentRow | null> {
  const read = await withTenant<{ rows: BugIncidentRow[] }>(ownerId, (q) =>
    q.query<BugIncidentRow>('SELECT * FROM dev_bug_incidents WHERE id = $1 AND owner_id = $2', [incidentId, ownerId]),
  );
  const row = read.rows[0];
  if (!row) return null;
  await withTenant(ownerId, (q) =>
    q.query(
      `UPDATE dev_bug_incidents SET status = 'FIXED', diagnosis = $1, fix_summary = $2, test_ref = $3, deploy_ref = $4, updated_at = now() WHERE id = $5`,
      [
        redactSecrets((fix.diagnosis ?? '').slice(0, 2000)).slice(0, 2000) || null,
        redactSecrets((fix.fixSummary ?? '').slice(0, 2000)).slice(0, 2000) || null,
        fix.testRef?.slice(0, 200) ?? null,
        fix.deployRef?.slice(0, 300) ?? null,
        row.id,
      ],
    ),
  );
  const after = await withTenant<{ rows: BugIncidentRow[] }>(ownerId, (q) => q.query<BugIncidentRow>('SELECT * FROM dev_bug_incidents WHERE id = $1', [row.id]));
  return after.rows[0] ?? null;
}

export async function listBugIncidents(ownerId: string, projectId?: string): Promise<BugIncidentRow[]> {
  const rows = await withTenant<{ rows: BugIncidentRow[] }>(ownerId, (q) =>
    q.query<BugIncidentRow>(
      `SELECT * FROM dev_bug_incidents WHERE owner_id = $1 ${projectId ? 'AND project_id = $2' : ''} ORDER BY last_seen_at DESC LIMIT 100`,
      projectId ? [ownerId, projectId] : [ownerId],
    ),
  );
  return rows.rows;
}

// ------------------------------------------------------------------ memory links

export async function addMemoryLink(
  ownerId: string,
  input: { projectId: string; kind: MemoryLinkKind; fromRef: string; toRef: string; evidence?: Record<string, unknown> },
): Promise<MemoryLinkRow> {
  const id = newId('mclk');
  await withTenant(ownerId, (q) =>
    q.query(
      `INSERT INTO memorycoding_links (id, owner_id, project_id, kind, from_ref, to_ref, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [id, ownerId, input.projectId, input.kind, input.fromRef.slice(0, 300), input.toRef.slice(0, 300),
       input.evidence ? JSON.stringify(input.evidence) : null],
    ),
  );
  const after = await withTenant<{ rows: MemoryLinkRow[] }>(ownerId, (q) => q.query<MemoryLinkRow>('SELECT * FROM memorycoding_links WHERE id = $1', [id]));
  return after.rows[0]!;
}

export async function listMemoryLinks(ownerId: string, projectId: string, kind?: MemoryLinkKind): Promise<MemoryLinkRow[]> {
  const rows = await withTenant<{ rows: MemoryLinkRow[] }>(ownerId, (q) =>
    q.query<MemoryLinkRow>(
      `SELECT * FROM memorycoding_links WHERE owner_id = $1 AND project_id = $2 ${kind ? 'AND kind = $3' : ''}
       ORDER BY created_at DESC LIMIT 100`,
      kind ? [ownerId, projectId, kind] : [ownerId, projectId],
    ),
  );
  return rows.rows;
}
