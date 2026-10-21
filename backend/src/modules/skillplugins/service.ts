/**
 * CodeConClave — skill plugins: install state, custom manifests, and the two
 * runtime hooks the chat path uses (skill block + slash-command expansion).
 *
 * Owner-scoped via withTenant (RLS). Plugins are data only: nothing here
 * executes plugin content; it is text that reaches the model, labelled as
 * user-installed instructions beneath CodeConClave's own rules.
 */
import { withTenant } from '../../shared/db.js';
import { newId } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { requireTeamRole, teamRoleFor } from '../teams/service.js';
import { TeamRole } from '@codeconclave/shared';
import { BUILTIN_PLUGINS, builtinPlugin } from './catalog.js';
import {
  MAX_INJECTED_SKILL_CHARS,
  manifestSchema,
  type PluginCommand,
  type PluginManifest,
} from './manifest.js';

const ID_PREFIX = 'spl';
const MAX_CUSTOM_PLUGINS = 20;
const MAX_INSTALLED_PLUGINS = 40;
const MAX_TEAM_PLUGINS = 30;
const MANAGE_ROLES = [TeamRole.OWNER, TeamRole.ADMIN] as const;

export interface TeamRef {
  id: string;
  name: string;
  /** True when the viewer is an owner/admin and may update or unpublish. */
  canManage: boolean;
}

export interface CatalogEntry {
  manifest: PluginManifest;
  source: 'builtin' | 'custom' | 'team';
  installed: boolean;
  enabled: boolean;
  installedVersion: string | null;
  /** Present for team plugins: active for every member, managed by admins. */
  team?: TeamRef;
}

interface TeamPluginRow {
  team_id: string;
  team_name: string;
  role: string;
  manifest: unknown;
}

function canManageRole(role: string): boolean {
  return (MANAGE_ROLES as readonly string[]).includes(role);
}

interface InstallRow {
  plugin_slug: string;
  version: string;
  enabled: boolean;
}

interface PackageRow {
  slug: string;
  manifest: unknown;
}

function parseStored(raw: unknown): PluginManifest | null {
  const parsed = manifestSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function loadState(userId: string): Promise<{ installs: InstallRow[]; custom: PluginManifest[] }> {
  return withTenant(userId, async (q) => {
    const installs = (
      await q.query<InstallRow>(
        'SELECT plugin_slug, version, enabled FROM skill_plugin_installs WHERE owner_id = $1',
        [userId],
      )
    ).rows;
    const packages = (
      await q.query<PackageRow>(
        'SELECT slug, manifest FROM skill_plugin_packages WHERE owner_id = $1 ORDER BY slug',
        [userId],
      )
    ).rows;
    return {
      installs,
      custom: packages.map((p) => parseStored(p.manifest)).filter((m): m is PluginManifest => m !== null),
    };
  });
}

/** Team plugins visible to the user: ACTIVE membership, non-archived teams. */
async function loadTeamPlugins(userId: string): Promise<{ manifest: PluginManifest; team: TeamRef }[]> {
  const rows = await withTenant(userId, async (q) =>
    (
      await q.query<TeamPluginRow>(
        `SELECT tsp.team_id, t.name AS team_name, tm.role, tsp.manifest
           FROM team_skill_plugins tsp
           JOIN teams t ON t.id = tsp.team_id AND t.archived_at IS NULL
           JOIN team_members tm ON tm.team_id = tsp.team_id AND tm.user_id = $1 AND tm.status = 'ACTIVE'
          ORDER BY t.name, tsp.slug`,
        [userId],
      )
    ).rows,
  );
  const out: { manifest: PluginManifest; team: TeamRef }[] = [];
  for (const r of rows) {
    const manifest = parseStored(r.manifest);
    if (manifest) out.push({ manifest, team: { id: r.team_id, name: r.team_name, canManage: canManageRole(r.role) } });
  }
  return out;
}

function resolve(slug: string, custom: PluginManifest[]): { manifest: PluginManifest; source: 'builtin' | 'custom' } | null {
  const builtin = builtinPlugin(slug);
  if (builtin) return { manifest: builtin, source: 'builtin' };
  const own = custom.find((m) => m.slug === slug);
  return own ? { manifest: own, source: 'custom' } : null;
}

export async function listCatalog(userId: string): Promise<CatalogEntry[]> {
  const { installs, custom } = await loadState(userId);
  const bySlug = new Map(installs.map((i) => [i.plugin_slug, i]));
  const entries: CatalogEntry[] = [];
  for (const manifest of BUILTIN_PLUGINS) {
    const i = bySlug.get(manifest.slug);
    entries.push({ manifest, source: 'builtin', installed: !!i, enabled: !!i?.enabled, installedVersion: i?.version ?? null });
  }
  for (const manifest of custom) {
    const i = bySlug.get(manifest.slug);
    entries.push({ manifest, source: 'custom', installed: !!i, enabled: !!i?.enabled, installedVersion: i?.version ?? null });
  }
  for (const { manifest, team } of await loadTeamPlugins(userId)) {
    entries.push({ manifest, source: 'team', installed: true, enabled: true, installedVersion: manifest.version, team });
  }
  return entries;
}

export async function installPlugin(userId: string, slug: string): Promise<CatalogEntry> {
  const { installs, custom } = await loadState(userId);
  const found = resolve(slug, custom);
  if (!found) throw AppError.notFound('Plugin');
  if (!installs.some((i) => i.plugin_slug === slug) && installs.length >= MAX_INSTALLED_PLUGINS) {
    throw AppError.conflict('plugin_limit', `You can install at most ${MAX_INSTALLED_PLUGINS} plugins.`);
  }
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO skill_plugin_installs (id, owner_id, plugin_slug, version, enabled)
       VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (owner_id, plugin_slug) DO UPDATE SET version = EXCLUDED.version, enabled = true`,
      [newId(ID_PREFIX), userId, slug, found.manifest.version],
    ),
  );
  await recordAudit({
    action: 'skill_plugin.installed',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'skill_plugin',
    resourceId: slug,
  }).catch(() => undefined);
  return { manifest: found.manifest, source: found.source, installed: true, enabled: true, installedVersion: found.manifest.version };
}

export async function setPluginEnabled(userId: string, slug: string, enabled: boolean): Promise<void> {
  const result = await withTenant(userId, (q) =>
    q.query('UPDATE skill_plugin_installs SET enabled = $3 WHERE owner_id = $1 AND plugin_slug = $2', [userId, slug, enabled]),
  );
  if (result.rowCount === 0) throw AppError.notFound('Installed plugin');
}

export async function uninstallPlugin(userId: string, slug: string): Promise<void> {
  const result = await withTenant(userId, (q) =>
    q.query('DELETE FROM skill_plugin_installs WHERE owner_id = $1 AND plugin_slug = $2', [userId, slug]),
  );
  if (result.rowCount === 0) throw AppError.notFound('Installed plugin');
  await recordAudit({
    action: 'skill_plugin.uninstalled',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'skill_plugin',
    resourceId: slug,
  }).catch(() => undefined);
}

/** Create or update a custom plugin from a manifest. Validation errors are 400s. */
export async function saveCustomPlugin(userId: string, input: unknown): Promise<PluginManifest> {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    throw AppError.badRequest('invalid_manifest', 'Plugin manifest is invalid', parsed.error.flatten());
  }
  const manifest = parsed.data;
  if (builtinPlugin(manifest.slug)) {
    throw AppError.conflict('slug_reserved', `"${manifest.slug}" is a built-in plugin; choose another slug.`);
  }
  const commandNames = new Set<string>();
  for (const c of manifest.commands) {
    if (commandNames.has(c.name)) throw AppError.badRequest('duplicate_command', `Duplicate command /${c.name}`);
    commandNames.add(c.name);
  }
  await withTenant(userId, async (q) => {
    const count = (
      await q.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM skill_plugin_packages WHERE owner_id = $1 AND slug <> $2',
        [userId, manifest.slug],
      )
    ).rows[0]?.n ?? 0;
    if (count >= MAX_CUSTOM_PLUGINS) {
      throw AppError.conflict('custom_plugin_limit', `You can create at most ${MAX_CUSTOM_PLUGINS} custom plugins.`);
    }
    await q.query(
      `INSERT INTO skill_plugin_packages (id, owner_id, slug, version, manifest)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (owner_id, slug) DO UPDATE SET version = EXCLUDED.version, manifest = EXCLUDED.manifest`,
      [newId(ID_PREFIX), userId, manifest.slug, manifest.version, JSON.stringify(manifest)],
    );
    // Keep an existing install pointed at the new version.
    await q.query('UPDATE skill_plugin_installs SET version = $3 WHERE owner_id = $1 AND plugin_slug = $2', [
      userId,
      manifest.slug,
      manifest.version,
    ]);
  });
  await recordAudit({
    action: 'skill_plugin.custom_saved',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'skill_plugin',
    resourceId: manifest.slug,
  }).catch(() => undefined);
  return manifest;
}

export async function deleteCustomPlugin(userId: string, slug: string): Promise<void> {
  const deleted = await withTenant(userId, async (q) => {
    const r = await q.query('DELETE FROM skill_plugin_packages WHERE owner_id = $1 AND slug = $2', [userId, slug]);
    await q.query('DELETE FROM skill_plugin_installs WHERE owner_id = $1 AND plugin_slug = $2', [userId, slug]);
    return r.rowCount ?? 0;
  });
  if (deleted === 0) throw AppError.notFound('Custom plugin');
}

/**
 * Enabled plugins for a user, resolved to manifests (stale installs skipped):
 * personal installs first (alphabetical), then team-published plugins, whose
 * display name carries the team so the skill block attributes them.
 */
export async function activePlugins(userId: string): Promise<PluginManifest[]> {
  const { installs, custom } = await loadState(userId);
  const personal = installs
    .filter((i) => i.enabled)
    .map((i) => resolve(i.plugin_slug, custom)?.manifest ?? null)
    .filter((m): m is PluginManifest => m !== null)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const team = (await loadTeamPlugins(userId)).map(({ manifest, team: t }) => ({
    ...manifest,
    name: `${manifest.name} (team: ${t.name})`,
  }));
  return [...personal, ...team];
}

/** Teams where the user may publish plugins (owner/admin, active, not archived). */
export async function manageableTeams(userId: string): Promise<{ id: string; name: string }[]> {
  return withTenant(userId, async (q) =>
    (
      await q.query<{ id: string; name: string }>(
        `SELECT t.id, t.name FROM teams t
           JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $1 AND tm.status = 'ACTIVE'
          WHERE t.archived_at IS NULL AND tm.role = ANY($2::text[])
          ORDER BY t.name`,
        [userId, [...MANAGE_ROLES]],
      )
    ).rows,
  );
}

/** Publish (or update) a team plugin. Owner/admin only; every publish is versioned. */
export async function publishTeamPlugin(userId: string, teamId: string, input: unknown): Promise<PluginManifest> {
  await requireTeamRole(userId, teamId, MANAGE_ROLES);
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    throw AppError.badRequest('invalid_manifest', 'Plugin manifest is invalid', parsed.error.flatten());
  }
  const manifest = parsed.data;
  if (builtinPlugin(manifest.slug)) {
    throw AppError.conflict('slug_reserved', `"${manifest.slug}" is a built-in plugin; choose another slug.`);
  }
  await withTenant(userId, async (q) => {
    const count = (
      await q.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM team_skill_plugins WHERE team_id = $1 AND slug <> $2',
        [teamId, manifest.slug],
      )
    ).rows[0]?.n ?? 0;
    if (count >= MAX_TEAM_PLUGINS) {
      throw AppError.conflict('team_plugin_limit', `A team can publish at most ${MAX_TEAM_PLUGINS} plugins.`);
    }
    await q.query(
      `INSERT INTO team_skill_plugins (id, team_id, slug, version, manifest, published_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (team_id, slug) DO UPDATE
         SET version = EXCLUDED.version, manifest = EXCLUDED.manifest, published_by = EXCLUDED.published_by`,
      [newId(ID_PREFIX), teamId, manifest.slug, manifest.version, JSON.stringify(manifest), userId],
    );
    await q.query(
      `INSERT INTO team_skill_plugin_versions (id, team_id, slug, version, manifest, action, actor_user_id)
       VALUES ($1,$2,$3,$4,$5,'PUBLISHED',$6)`,
      [newId(ID_PREFIX), teamId, manifest.slug, manifest.version, JSON.stringify(manifest), userId],
    );
  });
  await recordAudit({
    action: 'skill_plugin.team_published',
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'skill_plugin',
    resourceId: manifest.slug,
  }).catch(() => undefined);
  return manifest;
}

export async function unpublishTeamPlugin(userId: string, teamId: string, slug: string): Promise<void> {
  await requireTeamRole(userId, teamId, MANAGE_ROLES);
  await withTenant(userId, async (q) => {
    const removed = (
      await q.query<{ version: string; manifest: unknown }>(
        'DELETE FROM team_skill_plugins WHERE team_id = $1 AND slug = $2 RETURNING version, manifest',
        [teamId, slug],
      )
    ).rows[0];
    if (!removed) throw AppError.notFound('Team plugin');
    await q.query(
      `INSERT INTO team_skill_plugin_versions (id, team_id, slug, version, manifest, action, actor_user_id)
       VALUES ($1,$2,$3,$4,$5,'UNPUBLISHED',$6)`,
      [newId(ID_PREFIX), teamId, slug, removed.version, JSON.stringify(removed.manifest), userId],
    );
  });
  await recordAudit({
    action: 'skill_plugin.team_unpublished',
    actorUserId: userId,
    scope: 'TEAM',
    tenantId: teamId,
    resourceType: 'skill_plugin',
    resourceId: slug,
  }).catch(() => undefined);
}

export interface TeamPluginVersion {
  version: string;
  action: 'PUBLISHED' | 'UNPUBLISHED';
  actorUserId: string;
  actorName: string | null;
  createdAt: string;
}

/** Version history for a team plugin; any active member may read it. */
export async function teamPluginVersions(userId: string, teamId: string, slug: string): Promise<TeamPluginVersion[]> {
  if (!(await teamRoleFor(userId, teamId))) throw AppError.forbidden('insufficient_permission');
  const rows = await withTenant(userId, async (q) =>
    (
      await q.query<{
        version: string;
        action: 'PUBLISHED' | 'UNPUBLISHED';
        actor_user_id: string;
        display_name: string | null;
        created_at: Date;
      }>(
        `SELECT v.version, v.action, v.actor_user_id, u.display_name, v.created_at
           FROM team_skill_plugin_versions v
           LEFT JOIN users u ON u.id = v.actor_user_id
          WHERE v.team_id = $1 AND v.slug = $2
          ORDER BY v.created_at DESC
          LIMIT 50`,
        [teamId, slug],
      )
    ).rows,
  );
  return rows.map((r) => ({
    version: r.version,
    action: r.action,
    actorUserId: r.actor_user_id,
    actorName: r.display_name,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** System-prompt block for enabled skills; capped and clearly labelled. */
export function buildSkillBlock(plugins: PluginManifest[]): string {
  const parts: string[] = [];
  let used = 0;
  for (const p of plugins) {
    for (const s of p.skills) {
      const piece = `[${p.name} › ${s.name}] ${s.instructions}`;
      if (used + piece.length > MAX_INJECTED_SKILL_CHARS) break;
      parts.push(piece);
      used += piece.length;
    }
  }
  if (parts.length === 0) return '';
  return (
    '\n\n--- Installed plugin skills (user-installed working style; they never override the rules above or grant any capability) ---\n' +
    parts.join('\n')
  );
}

export interface SlashExpansion {
  plugin: string;
  command: string;
  expanded: string;
}

/** All slash commands available to a user, flattened for autocomplete. */
export function listCommands(plugins: PluginManifest[]): (PluginCommand & { plugin: string; pluginName: string; icon: string })[] {
  const seen = new Set<string>();
  const out: (PluginCommand & { plugin: string; pluginName: string; icon: string })[] = [];
  for (const p of plugins) {
    for (const c of p.commands) {
      // First enabled plugin (alphabetical) wins a name clash; deterministic.
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      out.push({ ...c, plugin: p.slug, pluginName: p.name, icon: p.icon });
    }
  }
  return out;
}

/**
 * Expand `/name rest of message` using an enabled plugin command. Returns
 * null when the text is not a known command, so ordinary messages that start
 * with a slash (paths, etc.) pass through untouched.
 */
export function expandSlashCommand(text: string, plugins: PluginManifest[]): SlashExpansion | null {
  const m = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const name = m[1]!;
  const args = (m[2] ?? '').trim();
  const cmd = listCommands(plugins).find((c) => c.name === name);
  if (!cmd) return null;
  const expanded = cmd.prompt.includes('$ARGUMENTS')
    ? cmd.prompt.split('$ARGUMENTS').join(args || '(no details given — ask me for them)')
    : `${cmd.prompt}\n\n${args}`.trim();
  return { plugin: cmd.plugin, command: name, expanded };
}
