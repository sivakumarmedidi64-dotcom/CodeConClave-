/**
 * CodeConClave — Secret Handling (V4E).
 * Never displays secret values. Shows only variable name, status, and target.
 * Allows secure credential entry through the platform.
 */
import { pool, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';

// ─── Types ─────────────────────────────────────────────────────

export type SecretStatus = 'CONFIGURED' | 'MISSING' | 'EMPTY' | 'PROVIDER_REQUIRED' | 'ENCRYPTED';

export interface SecretEntry {
  id: string;
  projectId: string;
  variableName: string;
  status: SecretStatus;
  targetService: string;
  isRequired: boolean;
  description?: string;
  lastRotated?: Date;
  expiresAt?: Date;
  encryptedAt?: Date;
}

export interface SecretInventory {
  id: string;
  projectId: string;
  checkedAt: Date;
  secrets: SecretEntry[];
  summary: {
    configured: number;
    missing: number;
    empty: number;
    providerRequired: number;
  };
  totalRequired: number;
  totalOptional: number;
}

export interface SecretEntryInput {
  variableName: string;
  value: string;
  targetService: string;
  description?: string;
}

export interface SecretValidationResult {
  variableName: string;
  valid: boolean;
  issues: string[];
  recommendations: string[];
}

// ─── Helpers ───────────────────────────────────────────────────

const SECRET_METADATA: Record<string, { target: string; required: boolean; description: string }> = {
  'DATABASE_URL': { target: 'postgresql', required: true, description: 'PostgreSQL connection string' },
  'REDIS_URL': { target: 'redis', required: false, description: 'Redis connection string' },
  'SESSION_SECRET': { target: 'backend', required: true, description: 'Session encryption key (min 32 chars)' },
  'JWT_SECRET': { target: 'backend', required: true, description: 'JWT signing key (min 32 chars)' },
  'OPENAI_API_KEY': { target: 'openai', required: false, description: 'OpenAI API key (sk-...)' },
  'ANTHROPIC_API_KEY': { target: 'anthropic', required: false, description: 'Anthropic API key' },
  'STRIPE_SECRET_KEY': { target: 'stripe', required: false, description: 'Stripe secret key (sk_live_... or sk_test_...)' },
  'RAZORPAY_KEY_ID': { target: 'razorpay', required: false, description: 'Razorpay key ID' },
  'RAZORPAY_KEY_SECRET': { target: 'razorpay', required: false, description: 'Razorpay key secret' },
  'RAZORPAY_WEBHOOK_SECRET': { target: 'razorpay', required: false, description: 'Razorpay webhook verification secret' },
  'RESEND_API_KEY': { target: 'resend', required: false, description: 'Resend email API key' },
  'GITHUB_CLIENT_ID': { target: 'github', required: false, description: 'GitHub OAuth client ID' },
  'GITHUB_CLIENT_SECRET': { target: 'github', required: false, description: 'GitHub OAuth client secret' },
  'GOOGLE_CLIENT_ID': { target: 'google', required: false, description: 'Google OAuth client ID' },
  'GOOGLE_CLIENT_SECRET': { target: 'google', required: false, description: 'Google OAuth client secret' },
};

const VALIDATION_RULES: Record<string, (value: string) => string[]> = {
  'DATABASE_URL': (v) => {
    const issues: string[] = [];
    if (!v.startsWith('postgres://') && !v.startsWith('postgresql://')) issues.push('Must start with postgres:// or postgresql://');
    if (v.includes('localhost') && !v.includes('test')) issues.push('Contains localhost — is this production?');
    return issues;
  },
  'SESSION_SECRET': (v) => {
    const issues: string[] = [];
    if (v.length < 32) issues.push('Must be at least 32 characters');
    if (v === 'change-me' || v === 'secret') issues.push('Must not be a default/weak value');
    return issues;
  },
  'JWT_SECRET': (v) => {
    const issues: string[] = [];
    if (v.length < 32) issues.push('Must be at least 32 characters');
    return issues;
  },
  'STRIPE_SECRET_KEY': (v) => {
    const issues: string[] = [];
    if (!v.startsWith('sk_')) issues.push('Should start with sk_');
    if (v.includes('test') && v.includes('live')) issues.push('Cannot be both test and live');
    return issues;
  },
  'REDIS_URL': (v) => {
    const issues: string[] = [];
    if (!v.startsWith('redis://') && !v.startsWith('rediss://')) issues.push('Must start with redis:// or rediss://');
    return issues;
  },
};

// ─── Main Functions ────────────────────────────────────────────

export async function createSecretInventory(
  userId: string,
  projectId: string,
  envVars: Record<string, string | undefined>,
  allRequiredVars: string[]
): Promise<SecretInventory> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]));
  if (!p.rows[0]) throw AppError.notFound('Project', 'project_not_found');

  const inventoryId = newId(PREFIX.DEPLOY_SECRETS);
  const secrets: SecretEntry[] = [];
  const allVars = new Set([...allRequiredVars, ...Object.keys(envVars)]);

  for (const varName of allVars) {
    const meta = SECRET_METADATA[varName] || { target: 'unknown', required: allRequiredVars.includes(varName), description: undefined };
    const value = envVars[varName];

    let status: SecretStatus;
    if (value && value.length > 0) {
      status = 'CONFIGURED';
    } else if (meta.required) {
      status = 'MISSING';
    } else {
      status = 'EMPTY';
    }

    if (varName.includes('API_KEY') || varName.includes('SECRET') || varName.includes('TOKEN')) {
      if (status === 'MISSING') status = 'PROVIDER_REQUIRED';
    }

    secrets.push({
      id: newId(PREFIX.DEPLOY_SECRETS),
      projectId,
      variableName: varName,
      status,
      targetService: meta.target,
      isRequired: meta.required,
      description: meta.description,
    });
  }

  const summary = {
    configured: secrets.filter(s => s.status === 'CONFIGURED').length,
    missing: secrets.filter(s => s.status === 'MISSING').length,
    empty: secrets.filter(s => s.status === 'EMPTY').length,
    providerRequired: secrets.filter(s => s.status === 'PROVIDER_REQUIRED').length,
  };

  const totalRequired = secrets.filter(s => s.isRequired).length;
  const totalOptional = secrets.filter(s => !s.isRequired).length;

  const inventory: SecretInventory = {
    id: inventoryId,
    projectId,
    checkedAt: new Date(),
    secrets,
    summary,
    totalRequired,
    totalOptional,
  };

  await pool.query(
    `INSERT INTO secret_inventories (id, project_id, secrets, summary, created_at)
     VALUES ($1, $2, $3, $4, now())`,
    [inventoryId, projectId, JSON.stringify(secrets), JSON.stringify(summary)],
  );

  await recordAudit({
    action: 'secret_inventory_created',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'secret_inventory',
    resourceId: inventoryId,
    detail: { configured: summary.configured, missing: summary.missing },
  });

  return inventory;
}

export function validateSecret(input: SecretEntryInput): SecretValidationResult {
  const issues: string[] = [];
  const recommendations: string[] = [];

  if (!input.variableName || input.variableName.length === 0) {
    issues.push('Variable name is required');
  }

  if (!input.value || input.value.length === 0) {
    issues.push('Value is required');
  }

  const rules = VALIDATION_RULES[input.variableName];
  if (rules && input.value) {
    issues.push(...rules(input.value));
  }

  if (input.variableName.includes('SECRET') || input.variableName.includes('KEY') || input.variableName.includes('TOKEN')) {
    recommendations.push('Rotate this credential periodically');
    if (input.value && input.value.length < 16) {
      issues.push('Secret value seems too short');
    }
  }

  if (input.variableName === 'STRIPE_SECRET_KEY' && input.value?.startsWith('sk_test_')) {
    recommendations.push('This is a TEST key — switch to sk_live_ for production');
  }

  if (input.variableName === 'DATABASE_URL' && input.value?.includes('localhost')) {
    recommendations.push('Consider using a managed database service for production');
  }

  return {
    variableName: input.variableName,
    valid: issues.length === 0,
    issues,
    recommendations,
  };
}

export async function recordSecretEntry(
  userId: string,
  projectId: string,
  variableName: string,
  targetService: string
): Promise<void> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]));
  if (!p.rows[0]) throw AppError.notFound('Project', 'project_not_found');

  await pool.query(
    `INSERT INTO secret_entries (id, project_id, variable_name, target_service, entered_by, created_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [newId(PREFIX.DEPLOY_SECRETS), projectId, variableName, targetService, userId],
  );

  await recordAudit({
    action: 'secret_entry_recorded',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'secret_entry',
    resourceId: variableName,
    detail: { variableName, targetService },
  });
}

export function maskSecret(value: string): string {
  if (!value || value.length < 8) return '****';
  const prefix = value.substring(0, 4);
  const suffix = value.substring(value.length - 4);
  const masked = '*'.repeat(Math.min(value.length - 8, 12));
  return `${prefix}${masked}${suffix}`;
}
