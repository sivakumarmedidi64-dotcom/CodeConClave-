/**
 * CodeConClave — Human Approval Gate (V4E).
 * Requires explicit human approval for production deployments,
 * database migrations, DNS changes, secret changes, payment config,
 * and destructive actions.
 */
import { pool, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';

// ─── Types ─────────────────────────────────────────────────────

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
export type ApprovalType =
  | 'PRODUCTION_DEPLOYMENT'
  | 'DATABASE_MIGRATION'
  | 'DNS_CHANGE'
  | 'SECRET_CHANGE'
  | 'PAYMENT_CONFIG'
  | 'DESTRUCTIVE_ACTION'
  | 'INFRASTRUCTURE_CHANGE';

export interface ApprovalRequest {
  id: string;
  projectId: string;
  type: ApprovalType;
  status: ApprovalStatus;
  requestedBy: string;
  approvedBy?: string;
  rejectedBy?: string;
  message: string;
  details: Record<string, unknown>;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  requestedAt: Date;
  resolvedAt?: Date;
  expiresAt: Date;
  metadata: Record<string, unknown>;
}

export interface ApprovalInput {
  projectId: string;
  type: ApprovalType;
  requestedBy: string;
  message: string;
  details: Record<string, unknown>;
  riskLevel?: ApprovalRequest['riskLevel'];
}

export interface ApprovalDecision {
  decision: 'APPROVED' | 'REJECTED';
  decidedBy: string;
  comment?: string;
}

// ─── Helpers ───────────────────────────────────────────────────

function getRiskLevel(type: ApprovalType): ApprovalRequest['riskLevel'] {
  switch (type) {
    case 'PRODUCTION_DEPLOYMENT': return 'HIGH';
    case 'DATABASE_MIGRATION': return 'HIGH';
    case 'DNS_CHANGE': return 'MEDIUM';
    case 'SECRET_CHANGE': return 'HIGH';
    case 'PAYMENT_CONFIG': return 'CRITICAL';
    case 'DESTRUCTIVE_ACTION': return 'CRITICAL';
    case 'INFRASTRUCTURE_CHANGE': return 'MEDIUM';
  }
}

function getExpiryMs(type: ApprovalType): number {
  switch (type) {
    case 'PRODUCTION_DEPLOYMENT': return 3600000; // 1 hour
    case 'DATABASE_MIGRATION': return 3600000;
    case 'DNS_CHANGE': return 7200000; // 2 hours
    case 'SECRET_CHANGE': return 3600000;
    case 'PAYMENT_CONFIG': return 1800000; // 30 minutes
    case 'DESTRUCTIVE_ACTION': return 1800000;
    case 'INFRASTRUCTURE_CHANGE': return 7200000;
  }
}

// ─── Main Functions ────────────────────────────────────────────

export async function requestApproval(userId: string, input: ApprovalInput): Promise<ApprovalRequest> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [input.projectId, userId]));
  if (!p.rows[0]) throw AppError.notFound('Project', 'project_not_found');

  const requestId = newId(PREFIX.DEPLOY_APPROVAL);
  const riskLevel = input.riskLevel || getRiskLevel(input.type);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + getExpiryMs(input.type));

  const request: ApprovalRequest = {
    id: requestId,
    projectId: input.projectId,
    type: input.type,
    status: 'PENDING',
    requestedBy: input.requestedBy,
    message: input.message,
    details: input.details,
    riskLevel,
    requestedAt: now,
    expiresAt,
    metadata: {},
  };

  await pool.query(
    `INSERT INTO deployment_approvals (id, project_id, type, status, requested_by, message, details, risk_level, requested_at, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
    [
      requestId, input.projectId, input.type, 'PENDING',
      input.requestedBy, input.message, JSON.stringify(input.details),
      riskLevel, now, expiresAt,
    ],
  );

  await recordAudit({
    action: 'deployment_approval_requested',
    actorUserId: input.requestedBy,
    scope: 'USER',
    tenantId: input.requestedBy,
    resourceType: 'deployment_approval',
    resourceId: requestId,
    detail: { type: input.type, riskLevel },
  });

  return request;
}

export async function decideApproval(
  userId: string,
  projectId: string,
  requestId: string,
  decision: ApprovalDecision
): Promise<ApprovalRequest> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]));
  if (!p.rows[0]) throw AppError.notFound('Project', 'project_not_found');

  const result = await pool.query(
    `SELECT * FROM deployment_approvals WHERE id = $1 AND project_id = $2`,
    [requestId, projectId],
  );

  if (result.rows.length === 0) throw AppError.notFound('Approval request', 'approval_not_found');

  const existing = result.rows[0] as any;
  if (existing.status !== 'PENDING') {
    throw AppError.badRequest('already_decided', `Approval request is already ${existing.status}`);
  }

  if (new Date(existing.expires_at) < new Date()) {
    await pool.query(
      `UPDATE deployment_approvals SET status = 'EXPIRED', resolved_at = now() WHERE id = $1`,
      [requestId],
    );
    throw AppError.badRequest('expired', 'Approval request has expired');
  }

  const now = new Date();
  const newStatus = decision.decision;

  await pool.query(
    `UPDATE deployment_approvals SET status = $1, resolved_at = $2, ${newStatus === 'APPROVED' ? 'approved_by' : 'rejected_by'} = $3 WHERE id = $4`,
    [newStatus, now, decision.decidedBy, requestId],
  );

  const updatedRequest: ApprovalRequest = {
    id: requestId,
    projectId,
    type: existing.type,
    status: newStatus,
    requestedBy: existing.requested_by,
    approvedBy: newStatus === 'APPROVED' ? decision.decidedBy : undefined,
    rejectedBy: newStatus === 'REJECTED' ? decision.decidedBy : undefined,
    message: existing.message,
    details: JSON.parse(existing.details || '{}'),
    riskLevel: existing.risk_level,
    requestedAt: existing.requested_at,
    resolvedAt: now,
    expiresAt: existing.expires_at,
    metadata: { comment: decision.comment },
  };

  await recordAudit({
    action: `deployment_approval_${newStatus.toLowerCase()}`,
    actorUserId: decision.decidedBy,
    scope: 'USER',
    tenantId: decision.decidedBy,
    resourceType: 'deployment_approval',
    resourceId: requestId,
    detail: { decision: newStatus, comment: decision.comment },
  });

  return updatedRequest;
}

export async function getApprovalStatus(
  projectId: string,
  requestId: string
): Promise<ApprovalRequest | null> {
  const result = await pool.query(
    `SELECT * FROM deployment_approvals WHERE id = $1 AND project_id = $2`,
    [requestId, projectId],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0] as any;
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    status: row.status,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    rejectedBy: row.rejected_by,
    message: row.message,
    details: JSON.parse(row.details || '{}'),
    riskLevel: row.risk_level,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    expiresAt: row.expires_at,
    metadata: {},
  };
}

export async function listPendingApprovals(
  projectId: string
): Promise<ApprovalRequest[]> {
  const result = await pool.query(
    `SELECT * FROM deployment_approvals WHERE project_id = $1 AND status = 'PENDING' ORDER BY requested_at DESC`,
    [projectId],
  );

  return (result.rows as any[]).map(row => ({
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    status: row.status,
    requestedBy: row.requested_by,
    message: row.message,
    details: JSON.parse(row.details || '{}'),
    riskLevel: row.risk_level,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    metadata: {},
  }));
}

export function requiresApproval(stepAction: string, isProduction: boolean): boolean {
  if (!isProduction) return false;
  const approvalActions = ['RUN_MIGRATION', 'DEPLOY', 'CONFIGURE_DOMAIN', 'CONFIGURE_PAYMENT'];
  return approvalActions.includes(stepAction);
}
