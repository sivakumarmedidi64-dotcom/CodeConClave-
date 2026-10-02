/**
 * CodeConClave — PKG-20 — per-project environment session state.
 * Persists the ACTIVE environment (DEVELOPMENT/STAGING/PRODUCTION) per project
 * and records auditable switches. Never stores or returns secret values.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AuditAction } from '@codeconclave/shared';
import { assertProjectAccess } from '../runtime/security.js';
import { recordAudit } from '../audit/service.js';
import { ENVIRONMENTS, type Environment, type EnvironmentSwitch } from './types.js';

function isEnvironment(v: string | null | undefined): v is Environment {
  return !!v && (ENVIRONMENTS as readonly string[]).includes(v);
}

/** Resolve the active environment for a project, defaulting to DEVELOPMENT. */
export async function getActiveEnvironment(userId: string, projectId: string): Promise<Environment> {
  await assertProjectAccess(userId, projectId);
  const row = await withTenant<{ environment: string } | null>(userId, (q) =>
    q
      .query<{ environment: string }>(
        'SELECT environment FROM environment_state WHERE project_id = $1 AND owner_id = $2',
        [projectId, userId],
      )
      .then((r) => r.rows[0] ?? null),
  );
  if (row && isEnvironment(row.environment)) return row.environment;
  return 'development';
}

/** Upsert the active environment snapshot (validation names-only). */
export async function setEnvironmentState(
  userId: string,
  projectId: string,
  environment: Environment,
  validation: { status: string; missing: string[]; invalid: string[] },
): Promise<void> {
  await assertProjectAccess(userId, projectId);
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO environment_state (project_id, owner_id, environment, validation_state, missing_vars, invalid_vars, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now())
       ON CONFLICT (project_id) DO UPDATE SET
         environment = EXCLUDED.environment,
         validation_state = EXCLUDED.validation_state,
         missing_vars = EXCLUDED.missing_vars,
         invalid_vars = EXCLUDED.invalid_vars,
         updated_at = now()`,
      [projectId, userId, environment, validation.status, JSON.stringify(validation.missing), JSON.stringify(validation.invalid)],
    ),
  );
}

/** Change the active environment with an audit trail. Requires confirmation for elevation. */
export async function switchEnvironment(
  userId: string,
  projectId: string,
  toEnv: Environment,
  opts: { reason?: string; confirmed?: boolean } = {},
): Promise<{ environment: Environment; switched: boolean; requiresConfirmation: boolean }> {
  await assertProjectAccess(userId, projectId);
  const fromEnv = await getActiveEnvironment(userId, projectId);

  const elevated = toEnv === 'production' && fromEnv !== 'production';
  const requiresConfirmation = elevated && opts.confirmed !== true;
  if (requiresConfirmation) {
    return { environment: fromEnv, switched: false, requiresConfirmation: true };
  }

  await setEnvironmentState(userId, projectId, toEnv, { status: 'UNVERIFIED', missing: [], invalid: [] });
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO environment_switches (id, project_id, owner_id, from_env, to_env, reason, confirmed)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newId(PREFIX.ENVIRONMENT_SWITCH), projectId, userId, fromEnv, toEnv, opts.reason ?? null, opts.confirmed === true],
    ),
  );
  await recordAudit({
    action: AuditAction.TERMINAL_SESSION_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'environment_switch',
    resourceId: projectId,
    detail: { event: 'environment.switch', from: fromEnv, to: toEnv, reason: opts.reason ?? null },
  });
  return { environment: toEnv, switched: true, requiresConfirmation: false };
}

/** Recent switch history for a project (names-only). */
export async function listSwitches(userId: string, projectId: string, limit = 20): Promise<EnvironmentSwitch[]> {
  await assertProjectAccess(userId, projectId);
  const rows = await withTenant<{
    id: string; from_env: string | null; to_env: string; reason?: string; confirmed: boolean; created_at: string;
  }[]>(userId, (q) =>
    q
      .query<{
        id: string; from_env: string | null; to_env: string; reason?: string; confirmed: boolean; created_at: string;
      }>(
        `SELECT id, from_env, to_env, reason, confirmed, created_at
         FROM environment_switches WHERE project_id = $1 AND owner_id = $2
         ORDER BY created_at DESC LIMIT $3`,
        [projectId, userId, limit],
      )
      .then((r) => r.rows),
  );
  return rows.map((r) => ({
    id: r.id,
    projectId,
    fromEnv: isEnvironment(r.from_env) ? r.from_env : null,
    toEnv: r.to_env as Environment,
    reason: r.reason,
    confirmed: r.confirmed,
    createdAt: r.created_at,
  }));
}
