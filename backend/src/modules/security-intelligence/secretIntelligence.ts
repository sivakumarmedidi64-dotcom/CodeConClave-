/**
 * CodeConClave — Secret Management Intelligence (V4C).
 * Extends the current Secret Guard (Stage 26G).
 * Supports: secret discovery, variable mapping, secret age awareness, unused-secret detection,
 * exposure detection, rotation reminders, audit.
 * NEVER displays the actual secret.
 */
import { withTenant, withSystem } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { newId, PREFIX } from '../../shared/ids.js';
import { scanContent, redactSecrets, SECRET_PATTERNS, listSecretGuardScans } from '../secretGuard/service.js';
import { globalSearch } from '../search/service.js';

export interface SecretMetadata {
  kind: string;
  label: string;
  firstDetected: Date;
  lastSeen: Date;
  detectionCount: number;
  locations: SecretLocation[];
  estimatedAge?: number; // days
  rotationStatus: 'CURRENT' | 'NEEDS_ROTATION' | 'OVERDUE' | 'UNKNOWN';
  rotationDueAt?: Date;
  rotationPolicy?: RotationPolicy;
  isUnused: boolean;
  lastUsedAt?: Date;
  exposureEvents: ExposureEvent[];
  rotationHistory: RotationEvent[];
}

export interface SecretLocation {
  filePath: string;
  line: number;
  targetType: string;
  targetRef?: string;
  scannedAt: Date;
}

export interface ExposureEvent {
  id: string;
  detectedAt: Date;
  targetType: string;
  targetRef: string | null;
  scannerType: 'secret_guard' | 'manual' | 'git_history';
  wasRedacted: boolean;
}

export interface RotationEvent {
  id: string;
  rotatedAt: Date;
  rotatedBy: string;
  previousKind: string;
  newKind: string;
  trigger: 'MANUAL' | 'SCHEDULED' | 'EXPOSURE' | 'POLICY';
}

export interface RotationPolicy {
  maxAgeDays: number;
  warnBeforeDays: number;
  autoRotate: boolean;
  allowedKinds: string[];
}

export interface UnusedSecret {
  kind: string;
  label: string;
  lastSeen: Date;
  locations: SecretLocation[];
  estimatedAge: number;
  recommendation: 'ROTATE' | 'REVOKE' | 'INVESTIGATE';
}

export interface RotationReminder {
  kind: string;
  label: string;
  dueAt: Date;
  daysUntilDue: number;
  severity: 'WARNING' | 'OVERDUE';
  locations: SecretLocation[];
}

export interface SecretAuditResult {
  summary: {
    totalSecrets: number;
    activeSecrets: number;
    expiredSecrets: number;
    unusedSecrets: number;
    exposedSecrets: number;
    rotationOverdue: number;
  };
  byKind: Record<string, { count: number; overdue: number; unused: number }>;
  rotationReminders: RotationReminder[];
  unusedSecrets: UnusedSecret[];
  exposureTimeline: ExposureEvent[];
}

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant<{ c: number } | null>(userId, (q) =>
    q.query<{ c: number }>('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]).then((r) => r.rows[0] ?? null),
  );
  if (!p) throw AppError.notFound('Project');
}

export async function scanProjectForSecrets(
  userId: string,
  projectId: string
): Promise<SecretAuditResult> {
  await assertProjectAccess(userId, projectId);

  const secretMetadata = new Map<string, SecretMetadata>();
  const exposureEvents: ExposureEvent[] = [];

  const files = await globalSearch(userId, { q: '', type: 'file', projectId, limit: 500 });
  const sourceFiles = files.results.filter(f => f.projectId);

  for (const file of sourceFiles) {
    if (!file.projectId) continue;
    const analysis = await withTenant<{ path: string; content: string } | null>(userId, (q) =>
      q
        .query<{ path: string; content: string }>(
          `SELECT path, content FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL`,
          [projectId, file.path as string],
        )
        .then((r) => r.rows[0] ?? null),
    );
    if (!analysis || !analysis.content) continue;

    const f = analysis;

    const scans = await listSecretGuardScans(userId, 1000);
    const relevantScans = scans.filter(s =>
      s.target_type === 'file' && s.target_ref === file.path
    );

    for (const scan of relevantScans) {
      if (scan.result === 'FINDINGS' && scan.findings) {
        for (const finding of scan.findings) {
          const key = `${finding.kind}:${file.path}:${finding.location}`;
          let metadata = secretMetadata.get(key);

          if (!metadata) {
            metadata = {
              kind: finding.kind,
              label: finding.label,
              firstDetected: scan.scanned_at,
              lastSeen: scan.scanned_at,
              detectionCount: 1,
              locations: [{
                filePath: (file.path as string) ?? '',
                line: finding.location,
                targetType: scan.target_type,
                targetRef: scan.target_ref ?? undefined,
                scannedAt: scan.scanned_at,
              }],
              rotationStatus: 'UNKNOWN',
              isUnused: true,
              exposureEvents: [],
              rotationHistory: [],
            };
            secretMetadata.set(key, metadata!);
          } else {
            metadata.lastSeen = scan.scanned_at > metadata.lastSeen ? scan.scanned_at : metadata.lastSeen;
            metadata.detectionCount++;
            metadata.locations.push({
              filePath: (file.path as string) ?? '',
              line: finding.location,
              targetType: scan.target_type,
              targetRef: scan.target_ref ?? undefined,
              scannedAt: scan.scanned_at,
            });
          }

          exposureEvents.push({
            id: newId(PREFIX.SECRET_EXPOSURE),
            detectedAt: scan.scanned_at,
            targetType: scan.target_type,
            targetRef: scan.target_ref,
            scannerType: 'secret_guard',
            wasRedacted: true,
          });
        }
      }
    }
  }

  const scans = await listSecretGuardScans(userId, 1000);
  for (const scan of scans) {
    if (scan.result === 'FINDINGS' && scan.findings) {
      for (const finding of scan.findings) {
        exposureEvents.push({
          id: newId(PREFIX.SECRET_EXPOSURE),
          detectedAt: scan.scanned_at,
          targetType: scan.target_type,
          targetRef: scan.target_ref,
          scannerType: 'secret_guard',
          wasRedacted: true,
        });
      }
    }
  }

  const byKind: Record<string, { count: number; overdue: number; unused: number }> = {};
  const rotationReminders: RotationReminder[] = [];
  const unusedSecrets: UnusedSecret[] = [];

  for (const [key, metadata] of secretMetadata) {
    const ageDays = Math.floor((Date.now() - metadata.firstDetected.getTime()) / (1000 * 60 * 60 * 24));

    if (!byKind[metadata.kind]) {
      byKind[metadata.kind] = { count: 0, overdue: 0, unused: 0 };
    }
    byKind[metadata.kind]!.count++;

    const isOverdue = metadata.rotationStatus === 'OVERDUE' ||
      (metadata.rotationDueAt && metadata.rotationDueAt < new Date());
    if (isOverdue) byKind[metadata.kind]!.overdue++;

    if (metadata.isUnused) {
      byKind[metadata.kind]!.unused++;
      unusedSecrets.push({
        kind: metadata.kind,
        label: metadata.label,
        lastSeen: metadata.lastSeen,
        locations: metadata.locations,
        estimatedAge: ageDays,
        recommendation: ageDays > 90 ? 'REVOKE' : ageDays > 30 ? 'ROTATE' : 'INVESTIGATE',
      });
    }

    if (metadata.rotationDueAt) {
      const daysUntilDue = Math.ceil((metadata.rotationDueAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (daysUntilDue <= 7) {
        rotationReminders.push({
          kind: metadata.kind,
          label: metadata.label,
          dueAt: metadata.rotationDueAt,
          daysUntilDue,
          severity: daysUntilDue <= 0 ? 'OVERDUE' : 'WARNING',
          locations: metadata.locations,
        });
      }
    }
  }

  const summary = {
    totalSecrets: secretMetadata.size,
    activeSecrets: Array.from(secretMetadata.values()).filter(m => !m.isUnused).length,
    expiredSecrets: Array.from(secretMetadata.values()).filter(m => m.rotationStatus === 'OVERDUE').length,
    unusedSecrets: Array.from(secretMetadata.values()).filter(m => m.isUnused).length,
    exposedSecrets: exposureEvents.length,
    rotationOverdue: Array.from(secretMetadata.values()).filter(m => m.rotationStatus === 'OVERDUE').length,
  };

  return {
    summary,
    byKind,
    rotationReminders: rotationReminders.sort((a, b) => a.daysUntilDue - b.daysUntilDue),
    unusedSecrets,
    exposureTimeline: exposureEvents.sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime()),
  };
}

export async function detectExposedSecrets(
  userId: string,
  projectId: string,
  options: { since?: Date; targetTypes?: string[] } = {}
): Promise<ExposureEvent[]> {
  await assertProjectAccess(userId, projectId);

  const scans = await listSecretGuardScans(userId, 1000);
  const exposures: ExposureEvent[] = [];

  for (const scan of scans) {
    if (options.since && scan.scanned_at < options.since!) continue;
    if (options.targetTypes && !options.targetTypes.includes(scan.target_type)) continue;
    if (scan.result === 'FINDINGS' && scan.findings) {
      for (const finding of scan.findings) {
        exposures.push({
          id: newId(PREFIX.SECRET_EXPOSURE),
          detectedAt: scan.scanned_at,
          targetType: scan.target_type,
          targetRef: scan.target_ref,
          scannerType: 'secret_guard',
          wasRedacted: true,
        });
      }
    }
  }

  return exposures.sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime());
}

export async function getSecretMetadata(
  userId: string,
  projectId: string,
  kind?: string
): Promise<SecretMetadata[]> {
  await assertProjectAccess(userId, projectId);

  const scans = await listSecretGuardScans(userId, 1000);
  const metadataMap = new Map<string, SecretMetadata>();

  for (const scan of scans) {
    if (scan.result !== 'FINDINGS' || !scan.findings) continue;
    if (kind && !scan.findings.some(f => f.kind === kind)) continue;

    for (const finding of scan.findings) {
      if (kind && finding.kind !== kind) continue;

      const key = `${finding.kind}:${scan.target_ref}:${finding.location}`;
      let metadata = metadataMap.get(key);

      if (!metadata) {
        metadata = {
          kind: finding.kind,
          label: finding.label,
          firstDetected: scan.scanned_at,
          lastSeen: scan.scanned_at,
          detectionCount: 1,
          locations: [{
            filePath: scan.target_ref || 'unknown',
            line: finding.location,
            targetType: scan.target_type,
            targetRef: scan.target_ref ?? undefined,
            scannedAt: scan.scanned_at,
          }],
          rotationStatus: 'UNKNOWN',
          isUnused: true,
          exposureEvents: [],
          rotationHistory: [],
        };
        metadataMap.set(key, metadata!);
      } else {
        metadata.lastSeen = scan.scanned_at > metadata.lastSeen ? scan.scanned_at : metadata.lastSeen;
        metadata.detectionCount++;
      }
    }
  }

  return Array.from(metadataMap.values());
}

export async function recordRotation(
  userId: string,
  projectId: string,
  kind: string,
  newKind: string,
  trigger: RotationEvent['trigger']
): Promise<void> {
  await assertProjectAccess(userId, projectId);

  const event: RotationEvent = {
    id: newId(PREFIX.SECRET_ROTATION),
    rotatedAt: new Date(),
    rotatedBy: userId,
    previousKind: kind,
    newKind,
    trigger,
  };

  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO secret_rotations (id, kind, new_kind, rotated_by, trigger, rotated_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [event.id, kind, newKind, userId, trigger, event.rotatedAt],
    ),
  );

  await recordAudit({
    action: AuditAction.SECRET_ROTATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'secret_rotation',
    resourceId: event.id,
    detail: { kind, newKind, trigger },
  });
}

export async function getRotationHistory(
  userId: string,
  projectId: string,
  kind?: string
): Promise<RotationEvent[]> {
  await assertProjectAccess(userId, projectId);

  let query = 'SELECT * FROM secret_rotations WHERE rotated_by = $1';
  const params: unknown[] = [userId];

  if (kind) {
    params.push(kind);
    query += ` AND kind = $${params.length}`;
  }

  query += ' ORDER BY rotated_at DESC';
  return withTenant<RotationEvent[]>(userId, async (q) => (await q.query<RotationEvent>(query, params)).rows);
}

export async function setRotationPolicy(
  userId: string,
  projectId: string,
  kind: string,
  policy: RotationPolicy
): Promise<void> {
  await assertProjectAccess(userId, projectId);

  await withSystem((q) =>
    q.query(
      `INSERT INTO secret_rotation_policies (kind, max_age_days, warn_before_days, auto_rotate, allowed_kinds)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (kind) DO UPDATE SET
         max_age_days = EXCLUDED.max_age_days,
         warn_before_days = EXCLUDED.warn_before_days,
         auto_rotate = EXCLUDED.auto_rotate,
         allowed_kinds = EXCLUDED.allowed_kinds`,
      [kind, policy.maxAgeDays, policy.warnBeforeDays, policy.autoRotate, JSON.stringify(policy.allowedKinds)],
    ),
  );

  await recordAudit({
    action: AuditAction.SECRET_POLICY_UPDATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'secret_rotation_policy',
    resourceId: kind,
    detail: policy as unknown as Record<string, unknown>,
  });
}

export async function getRotationPolicies(
  userId: string,
  projectId: string
): Promise<Record<string, RotationPolicy>> {
  await assertProjectAccess(userId, projectId);

  const rows = await withSystem<{ kind: string; max_age_days: number; warn_before_days: number; auto_rotate: boolean; allowed_kinds: string }[]>(async (q) =>
    (await q.query<{ kind: string; max_age_days: number; warn_before_days: number; auto_rotate: boolean; allowed_kinds: string }>(
      'SELECT kind, max_age_days, warn_before_days, auto_rotate, allowed_kinds FROM secret_rotation_policies',
      [],
    )).rows,
  );

  const policies: Record<string, RotationPolicy> = {};
  for (const row of rows) {
    policies[row.kind] = {
      maxAgeDays: row.max_age_days,
      warnBeforeDays: row.warn_before_days,
      autoRotate: row.auto_rotate,
      allowedKinds: row.allowed_kinds ? JSON.parse(row.allowed_kinds) : [],
    };
  }
  return policies;
}

export async function redactSecretsInContent(
  userId: string,
  projectId: string,
  content: string
): Promise<string> {
  await assertProjectAccess(userId, projectId);
  return redactSecrets(content);
}

export async function getExposureStats(
  userId: string,
  projectId: string,
  options: { since?: Date; groupBy?: 'day' | 'week' | 'month' } = {}
): Promise<{ timeline: { period: string; count: number }[]; byKind: Record<string, number>; byTarget: Record<string, number> }> {
  await assertProjectAccess(userId, projectId);

  const exposures = await detectExposedSecrets(userId, projectId, { since: options.since });

  const byKind: Record<string, number> = {};
  const byTarget: Record<string, number> = {};
  const timeline: Record<string, number> = {};

  const formatPeriod = (date: Date, groupBy: string) => {
    const d = new Date(date);
    if (groupBy === 'week') {
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      return weekStart.toISOString().split('T')[0];
    }
    if (groupBy === 'month') {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    return d.toISOString().split('T')[0];
  };

  for (const exp of await listSecretGuardScans(userId, 1000)) {
    if (exp.result !== 'FINDINGS') continue;
    if (options.since && exp.scanned_at < options.since!) continue;

    for (const finding of exp.findings || []) {
      if (!finding.kind) continue;
      byKind[finding.kind] = (byKind[finding.kind] || 0) + 1;
      byTarget[exp.target_type] = (byTarget[exp.target_type] || 0) + 1;

      const period = formatPeriod(exp.scanned_at, options.groupBy || 'day')!;
      timeline[period] = (timeline[period] || 0) + 1;
    }
  }

  return {
    timeline: Object.entries(timeline).map(([period, count]) => ({ period, count })).sort((a, b) => a.period.localeCompare(b.period)),
    byKind,
    byTarget,
  };
}