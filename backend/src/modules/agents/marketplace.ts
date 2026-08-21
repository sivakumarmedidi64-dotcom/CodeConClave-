/**
 * CodeConClave — Stage 26A: agent marketplace.
 *
 * Community/custom agent packages install through the EXISTING agent pipeline:
 * install creates a REAL ai_agents row (role, capabilities, objective) with
 * plan limits (MAX_AGENTS) enforced; execution goes through the same
 * policy → permission → approval → execution → audit path. Packages declare
 * permissions INFORMATIONALLY — the engine never grants new privileges;
 * capabilities are validated against a known allowlist. Disabled packages
 * cannot run (startRun refuses them). Tenant isolation via owner-scoped RLS.
 */
import { pool, queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { createAgent, deleteAgent, getAgent, type AgentRow } from './service.js';

const ALLOWED_CAPABILITIES = new Set([
  'code', 'review', 'test', 'research', 'docs', 'devops', 'security', 'ui_ux', 'design',
]);

export interface CatalogueRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  role: string;
  capabilities: string[];
  declared_permissions: string[];
  min_trust_level: string;
  min_plan: string;
  version: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface InstalledRow {
  id: string;
  owner_id: string;
  catalogue_id: string;
  catalogue_slug: string;
  agent_id: string;
  version: string;
  status: 'INSTALLED' | 'DISABLED' | 'REMOVED';
  created_at: Date;
  updated_at: Date;
}

const VALID_CAPABILITIES_MESSAGE =
  `Invalid agent package: capabilities must be from the allowlist (${[...ALLOWED_CAPABILITIES].join(', ')}). ` +
  'Marketplace agents cannot inject arbitrary privileged tools.';

function mapCatalogue(row: Record<string, unknown>): CatalogueRow {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: row.description === null ? null : String(row.description),
    role: String(row.role),
    capabilities: (row.capabilities as string[]) ?? [],
    declared_permissions: (row.declared_permissions as string[]) ?? [],
    min_trust_level: String(row.min_trust_level),
    min_plan: String(row.min_plan),
    version: String(row.version),
    enabled: Boolean(row.enabled),
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
  };
}

function mapInstalled(row: Record<string, unknown>): InstalledRow {
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    catalogue_id: String(row.catalogue_id),
    catalogue_slug: String(row.catalogue_slug),
    agent_id: String(row.agent_id),
    version: String(row.version),
    status: String(row.status) as InstalledRow['status'],
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
  };
}

/** Browse + search the catalogue (public, read-only service table). */
export async function browseCatalogue(q?: string, role?: string): Promise<CatalogueRow[]> {
  const params: unknown[] = [];
  const where: string[] = ['enabled = true'];
  if (role) {
    where.push('role = $' + (params.length + 1));
    params.push(String(role).toUpperCase());
  }
  if (q && q.trim()) {
    params.push(`%${q.trim().toLowerCase()}%`);
    where.push(`(lower(name) LIKE $${params.length} OR lower(description) LIKE $${params.length} OR lower(slug) LIKE $${params.length})`);
  }
  const rows = await queryMany<Record<string, unknown>>(
    `SELECT * FROM agent_catalogue WHERE ${where.join(' AND ')} ORDER BY name ASC`,
    params,
  );
  return rows.map(mapCatalogue);
}

export async function getCatalogueItem(catalogueId: string): Promise<CatalogueRow> {
  const rows = await queryMany<Record<string, unknown>>('SELECT * FROM agent_catalogue WHERE id = $1', [catalogueId]);
  if (!rows[0]) throw AppError.notFound('Marketplace package');
  return mapCatalogue(rows[0]);
}

export async function listInstalled(userId: string): Promise<Array<InstalledRow & { agent: AgentRow | null; package: CatalogueRow | null }>> {
  const rows = await queryMany<Record<string, unknown>>(
    `SELECT i.*, a.id AS a_id, a.name AS a_name, a.role AS a_role, a.status AS a_status, a.trust_level AS a_trust_level,
            c.name AS c_name, c.description AS c_description, c.capabilities AS c_capabilities,
            c.declared_permissions AS c_permissions, c.min_trust_level AS c_min_trust, c.min_plan AS c_min_plan, c.version AS c_version
     FROM installed_agents i
     LEFT JOIN ai_agents a ON a.id = i.agent_id
     LEFT JOIN agent_catalogue c ON c.id = i.catalogue_id
     WHERE i.owner_id = $1 AND i.status <> 'REMOVED'
     ORDER BY i.created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    ...mapInstalled(r),
    agent: r.a_id
      ? {
          id: String(r.a_id), owner_id: userId, name: String(r.a_name), role: String(r.a_role),
          objective: null, capabilities: [], model_provider: null, model_id: null,
          max_tasks_per_run: 3, max_retries: 1, status: String(r.a_status), current_run_id: null,
          trust_level: String(r.a_trust_level ?? 'L2'), created_at: new Date(), updated_at: new Date(),
        }
      : null,
    package: r.c_name
      ? {
          id: String(r.catalogue_id), slug: String(r.catalogue_slug), name: String(r.c_name),
          description: r.c_description === null ? null : String(r.c_description), role: String(r.a_role),
          capabilities: (r.c_capabilities as string[]) ?? [], declared_permissions: (r.c_permissions as string[]) ?? [],
          min_trust_level: String(r.c_min_trust ?? 'L1'), min_plan: String(r.c_min_plan ?? 'free'),
          version: String(r.c_version), enabled: true, created_at: new Date(), updated_at: new Date(),
        }
      : null,
  }));
}

function assertValidPackage(catalogue: CatalogueRow): void {
  for (const cap of catalogue.capabilities) {
    if (!ALLOWED_CAPABILITIES.has(cap)) {
      throw AppError.badRequest('invalid_agent_package', VALID_CAPABILITIES_MESSAGE);
    }
  }
  for (const perm of catalogue.declared_permissions) {
    if (typeof perm !== 'string' || !/^[a-z_.]{1,60}$/.test(perm)) {
      throw AppError.badRequest('invalid_agent_package', 'Invalid declared permission scope in package');
    }
  }
}

/** Install a package: creates a REAL agent through the existing pipeline
 *  (plan limits enforced), records the install, and audits it. */
export async function installPackage(
  userId: string,
  catalogueId: string,
  input: { agentName?: string; trustLevel?: string },
): Promise<InstalledRow & { agent: AgentRow }> {
  const catalogue = await getCatalogueItem(catalogueId);
  assertValidPackage(catalogue);
  const existing = await queryMany<{ n: number }>(
    'SELECT count(*)::int AS n FROM installed_agents WHERE owner_id = $1 AND catalogue_id = $2 AND status <> \'REMOVED\'',
    [userId, catalogueId],
  );
  if ((existing[0]?.n ?? 0) > 0) {
    throw AppError.conflict('already_installed', `Package ${catalogue.slug} is already installed`);
  }
  const agent = await createAgent(userId, {
    name: input.agentName?.trim().slice(0, 120) || catalogue.name,
    role: catalogue.role,
    objective: catalogue.description?.slice(0, 2000) ?? undefined,
    capabilities: catalogue.capabilities,
    trustLevel: catalogue.min_trust_level,
  });
  const id = newId(PREFIX.INSTALLED_AGENT);
  await pool.query(
    `INSERT INTO installed_agents (id, owner_id, catalogue_id, catalogue_slug, agent_id, version, status)
     VALUES ($1,$2,$3,$4,$5,$6,'INSTALLED')`,
    [id, userId, catalogue.id, catalogue.slug, agent.id, catalogue.version],
  );
  await recordAudit({
    action: AuditAction.MARKETPLACE_INSTALLED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'agent_catalogue',
    resourceId: catalogue.id,
    detail: { slug: catalogue.slug, version: catalogue.version, agentId: agent.id, declaredPermissions: catalogue.declared_permissions },
  });
  return { ...mapInstalled({ id, owner_id: userId, catalogue_id: catalogue.id, catalogue_slug: catalogue.slug, agent_id: agent.id, version: catalogue.version, status: 'INSTALLED', created_at: new Date(), updated_at: new Date() }), agent };
}

export async function setInstalledStatus(userId: string, installedId: string, status: 'DISABLED' | 'ENABLED'): Promise<void> {
  const rows = await queryMany<Record<string, unknown>>(
    'SELECT * FROM installed_agents WHERE id = $1 AND owner_id = $2 AND status <> \'REMOVED\'',
    [installedId, userId],
  );
  if (!rows[0]) throw AppError.notFound('Installed agent');
  const next = status === 'DISABLED' ? 'DISABLED' : 'INSTALLED';
  await pool.query('UPDATE installed_agents SET status = $1, updated_at = now() WHERE id = $2', [next, installedId]);
  await recordAudit({
    action: status === 'DISABLED' ? AuditAction.MARKETPLACE_DISABLED : AuditAction.MARKETPLACE_ENABLED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'installed_agents',
    resourceId: installedId,
    detail: { catalogueSlug: String(rows[0].catalogue_slug) },
  });
}

/** Uninstall: deletes the created agent (existing deleteAgent — refuses while
 *  a run is active) and marks the install REMOVED for audit. */
export async function uninstallPackage(userId: string, installedId: string): Promise<void> {
  const rows = await queryMany<Record<string, unknown>>(
    'SELECT * FROM installed_agents WHERE id = $1 AND owner_id = $2 AND status <> \'REMOVED\'',
    [installedId, userId],
  );
  if (!rows[0]) throw AppError.notFound('Installed agent');
  await deleteAgent(userId, String(rows[0].agent_id));
  await pool.query('UPDATE installed_agents SET status = \'REMOVED\', updated_at = now() WHERE id = $1', [installedId]);
  await recordAudit({
    action: AuditAction.MARKETPLACE_UNINSTALLED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'installed_agents',
    resourceId: installedId,
    detail: { catalogueSlug: String(rows[0].catalogue_slug) },
  });
}

/** Update to a newer catalogue version: syncs name/objective/trust on the
 *  existing agent row (audited), records the version. */
export async function updateInstalled(userId: string, installedId: string): Promise<void> {
  const rows = await queryMany<Record<string, unknown>>(
    `SELECT i.*, c.* FROM installed_agents i JOIN agent_catalogue c ON c.id = i.catalogue_id
     WHERE i.id = $1 AND i.owner_id = $2 AND i.status <> 'REMOVED'`,
    [installedId, userId],
  );
  if (!rows[0]) throw AppError.notFound('Installed agent');
  const catalogue = mapCatalogue(rows[0]);
  assertValidPackage(catalogue);
  await pool.query('UPDATE ai_agents SET name = $1, objective = $2, updated_at = now() WHERE id = $3', [
    catalogue.name, catalogue.description?.slice(0, 2000) ?? null, String(rows[0].agent_id),
  ]);
  await pool.query('UPDATE installed_agents SET version = $1, updated_at = now() WHERE id = $2', [catalogue.version, installedId]);
  await recordAudit({
    action: AuditAction.MARKETPLACE_UPDATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'installed_agents',
    resourceId: installedId,
    detail: { catalogueSlug: catalogue.slug, version: catalogue.version },
  });
}

/** startRun integration: refuse execution for DISABLED marketplace agents. */
export async function assertInstalledAgentEnabled(userId: string, agentId: string): Promise<void> {
  const rows = await queryMany<{ status: string }>(
    'SELECT status FROM installed_agents WHERE owner_id = $1 AND agent_id = $2 AND status <> \'REMOVED\'',
    [userId, agentId],
  );
  if (rows[0] && rows[0].status === 'DISABLED') {
    throw AppError.conflict('agent_disabled', 'This marketplace agent is disabled; enable it before running');
  }
}