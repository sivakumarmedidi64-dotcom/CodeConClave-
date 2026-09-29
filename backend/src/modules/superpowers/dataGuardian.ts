/**
 * CodeConClave — Superpowers: DATA GUARDIAN (Master Feature #42).
 *
 * Every PII sighting tracked by CONCRETE type — email, phone, SSN, credit
 * card — and by where it lives: storage, log sink, API response or database.
 * Nothing is "detected"; each finding is typed, located and remediated with an
 * audit trail. GDPR/CCPA compliance becomes a query.
 *
 * Pure detection first, then owner-scoped, audited storage.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type PiiType = 'EMAIL' | 'PHONE' | 'SSN' | 'CREDIT_CARD';

export interface PiiHit {
  type: PiiType;
  sample: string;
}

const DETECTORS: Array<{ type: PiiType; re: RegExp }> = [
  { type: 'EMAIL', re: /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi },
  { type: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: 'CREDIT_CARD', re: /\b(?:\d[ -]?){15,16}\b/g },
  { type: 'PHONE', re: /\b(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g },
];

export function scanForPII(content: string): PiiHit[] {
  const hits: PiiHit[] = [];
  for (const { type, re } of DETECTORS) {
    const found = re.exec(content ?? '');
    if (found) hits.push({ type, sample: found[0] });
  }
  return hits;
}

export interface PiiInput {
  targetPath: string;
  locationType: 'STORAGE' | 'LOG_SINK' | 'API_RESPONSE' | 'DATABASE';
  contentSample?: string;
  piiTypes?: PiiType[];
  projectId?: string | null;
}

export interface PiiRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  target_path: string;
  location_type: PiiInput['locationType'];
  pii_types: PiiType[];
  content_sample: string | null;
  status: 'TRACKED' | 'REMEDIATED';
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): PiiRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  target_path: String(r.target_path),
  location_type: r.location_type as PiiRow['location_type'],
  pii_types: Array.isArray(r.pii_types) ? (r.pii_types as PiiType[]) : [],
  content_sample: r.content_sample ? String(r.content_sample) : null,
  status: r.status as PiiRow['status'],
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function findPiiById(userId: string, id: string): Promise<PiiRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM pii_findings WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('pii_not_found', 'no PII finding found for that id');
  return rowOf(row);
}

export async function recordPiiFinding(userId: string, input: PiiInput): Promise<PiiRow> {
  const targetPath = String(input.targetPath ?? '').trim();
  const contentSample = input.contentSample ? String(input.contentSample) : null;
  if (!targetPath) throw AppError.badRequest('invalid_target', 'targetPath is required');
  const detected = contentSample ? scanForPII(contentSample) : [];
  const piiTypes: PiiType[] = input.piiTypes ?? detected.map((h) => h.type);
  if (piiTypes.length === 0) throw AppError.badRequest('no_pii', 'nothing personally identifiable found');
  const id = newId(PREFIX.PII_FINDING);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO pii_findings (id, owner_id, project_id, target_path, location_type, pii_types, content_sample) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)',
    [id, userId, input.projectId ?? null, targetPath, input.locationType, JSON.stringify(piiTypes), contentSample],
  ));
  await recordAudit({
    action: AuditAction.PII_FOUND,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'pii_findings',
    resourceId: id,
    detail: { targetPath, piiTypes, locationType: input.locationType },
  });
  return findPiiById(userId, id);
}

export async function listPiiFindings(userId: string, filter: { status?: 'TRACKED' | 'REMEDIATED'; locationType?: PiiInput['locationType'] } = {}): Promise<PiiRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM pii_findings WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  if (filter.locationType) rows = rows.filter((r) => r.location_type === filter.locationType);
  return rows.sort((a, b) => (b.created_at.getTime() - a.created_at.getTime()) || b.id.localeCompare(a.id));
}

export async function remediatePiiFinding(userId: string, id: string): Promise<PiiRow> {
  const finding = await findPiiById(userId, id);
  if (finding.status !== 'REMEDIATED') {
    await withTenant(userId, (q) => q.query("UPDATE pii_findings SET status = 'REMEDIATED', updated_at = now() WHERE id = $1 AND owner_id = $2", [id, userId]));
  }
  await recordAudit({
    action: AuditAction.PII_REMEDIATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'pii_findings',
    resourceId: id,
    detail: { targetPath: finding.target_path, piiTypes: finding.pii_types },
  });
  return findPiiById(userId, id);
}