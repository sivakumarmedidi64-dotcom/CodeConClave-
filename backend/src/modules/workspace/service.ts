/**
 * CodeConClave — workspace module.
 * workspace_state (continuity + multi-device reconciliation), user_preferences,
 * usage counters (server-authoritative free limits), feature flags, context
 * indicator. Return-to-work summaries live in the returnToWork module.
 */
import { pool, withTenant, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { env } from '../../config/env.js';
import { WorkspaceStateKey, PlanId } from '@codeconclave/shared';
import { cache } from '../../shared/cache.js';

// ---------------------------------------------------------------- workspace state

export interface WorkspaceStateEntry {
  key: string;
  value: Record<string, unknown>;
  version: number;
  updatedAt: Date;
}

export interface WorkspaceStateRow {
  id: string;
  owner_id: string;
  key: string;
  value: Record<string, unknown>;
  version: number;
  updated_at: Date;
}

/**
 * Persist a workspace key. When `baseVersion` is supplied the update is
 * optimistic-locked: if the stored version no longer matches, a 409
 * `workspace_conflict` is raised with the current state so the client can
 * reconcile (foundation for multi-device sync conflict detection).
 */
export async function setWorkspaceState(
  userId: string,
  key: string,
  value: Record<string, unknown>,
  baseVersion?: number,
): Promise<WorkspaceStateEntry> {
  if (baseVersion !== undefined) {
    const result = await pool.query(
      `UPDATE workspace_state SET value = $3::jsonb, version = version + 1, updated_at = now()
       WHERE owner_id = $1 AND key = $2 AND version = $4
       RETURNING key, value, version, updated_at`,
      [userId, key, JSON.stringify(value), baseVersion],
    );
    const row = result.rows[0] as WorkspaceStateRow | undefined;
    if (!row) {
      const current = await queryMany<WorkspaceStateRow>(
        'SELECT key, value, version, updated_at FROM workspace_state WHERE owner_id = $1 AND key = $2',
        [userId, key],
      );
      throw AppError.conflict('workspace_conflict', 'Workspace state changed on another device', {
        current: current[0]
          ? { key: current[0].key, value: current[0].value, version: current[0].version, updatedAt: current[0].updated_at }
          : null,
      });
    }
    return { key: row.key, value: row.value, version: row.version, updatedAt: row.updated_at };
  }
  const result = await pool.query(
    `INSERT INTO workspace_state (id, owner_id, key, value, version)
     VALUES ($1,$2,$3,$4::jsonb, 1)
     ON CONFLICT (owner_id, key) DO UPDATE
       SET value = EXCLUDED.value, version = workspace_state.version + 1, updated_at = now()
     RETURNING key, value, version, updated_at`,
    [newId(PREFIX.WORKSPACE), userId, key, JSON.stringify(value)],
  );
  const row = result.rows[0] as WorkspaceStateRow | undefined;
  return row
    ? { key: row.key, value: row.value, version: row.version, updatedAt: row.updated_at }
    : { key, value, version: 1, updatedAt: new Date() };
}

export async function getWorkspaceState(userId: string, key: string): Promise<Record<string, unknown> | null> {
  const rows = await queryMany<{ value: Record<string, unknown> }>(
    'SELECT value FROM workspace_state WHERE owner_id = $1 AND key = $2',
    [userId, key],
  );
  return rows[0]?.value ?? null;
}

export async function getWorkspaceStateDetailed(userId: string, key: string): Promise<WorkspaceStateEntry | null> {
  const rows = await queryMany<WorkspaceStateRow>(
    'SELECT key, value, version, updated_at FROM workspace_state WHERE owner_id = $1 AND key = $2',
    [userId, key],
  );
  if (!rows[0]) return null;
  return { key: rows[0].key, value: rows[0].value, version: rows[0].version, updatedAt: rows[0].updated_at };
}

export async function listWorkspaceState(userId: string): Promise<WorkspaceStateEntry[]> {
  const rows = await queryMany<WorkspaceStateRow>(
    'SELECT key, value, version, updated_at FROM workspace_state WHERE owner_id = $1 ORDER BY updated_at DESC',
    [userId],
  );
  return rows.map((r) => ({ key: r.key, value: r.value, version: r.version, updatedAt: r.updated_at }));
}

// ---------------------------------------------------------------- conflict reconciliation (Phase 12)

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deterministic field-level merge for multi-device reconciliation.
 * Rules: the current server state is preserved on every scalar conflict;
 * client-only keys are adopted; nested plain objects are merged recursively;
 * arrays are treated as atomic values (server wins). Returns the paths the
 * client lost so the caller can surface them honestly.
 */
export function mergeWorkspaceValues(
  server: Record<string, unknown>,
  client: Record<string, unknown>,
): { merged: Record<string, unknown>; dropped: string[] } {
  const dropped: string[] = [];
  const merged: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(server), ...Object.keys(client)]);
  for (const key of keys) {
    const s = server[key];
    const c = client[key];
    if (isPlainObject(s) && isPlainObject(c)) {
      const nested = mergeWorkspaceValues(s, c);
      merged[key] = nested.merged;
      for (const path of nested.dropped) dropped.push(`${key}.${path}`);
    } else if (key in client && !(key in server)) {
      merged[key] = c;
    } else {
      merged[key] = key in server ? s : c;
      if (key in client && key in server && !Object.is(s, c)) dropped.push(key);
    }
  }
  return { merged, dropped };
}

export interface ReconcileResult {
  entry: WorkspaceStateEntry;
  reconciled: boolean;
  dropped: string[];
  currentVersion: number | null;
}

/**
 * Optimistic write with deterministic reconciliation: when `baseVersion`
 * no longer matches the stored version, the server value is preserved and
 * the client's version is merged in field-by-field instead of failing.
 * Never silently overwrites: every dropped path is reported.
 */
export async function reconcileWorkspaceState(
  userId: string,
  key: string,
  value: Record<string, unknown>,
  baseVersion?: number,
): Promise<ReconcileResult> {
  const current = await getWorkspaceStateDetailed(userId, key);
  if (!current) {
    const entry = await setWorkspaceState(userId, key, value);
    return { entry, reconciled: false, dropped: [], currentVersion: null };
  }
  if (baseVersion === undefined || current.version === baseVersion) {
    const entry = await setWorkspaceState(userId, key, value, baseVersion);
    return { entry, reconciled: false, dropped: [], currentVersion: current.version };
  }
  const { merged, dropped } = mergeWorkspaceValues(current.value, value);
  const entry = await setWorkspaceState(userId, key, merged);
  return { entry, reconciled: true, dropped, currentVersion: current.version };
}

/**
 * Bulk restore of a workspace snapshot (e.g. return from another device):
 * every entry is applied with the same deterministic reconciliation.
 */
export async function restoreWorkspaceState(
  userId: string,
  entries: { key: string; value: Record<string, unknown>; baseVersion?: number }[],
): Promise<{ applied: WorkspaceStateEntry[]; conflicts: { key: string; currentVersion: number | null }[] }> {
  const applied: WorkspaceStateEntry[] = [];
  const conflicts: { key: string; currentVersion: number | null }[] = [];
  for (const entry of entries) {
    const result = await reconcileWorkspaceState(userId, entry.key, entry.value, entry.baseVersion);
    applied.push(result.entry);
    if (result.reconciled) conflicts.push({ key: entry.key, currentVersion: result.currentVersion });
  }
  return { applied, conflicts };
}

// ---------------------------------------------------------------- preferences

export async function getPreferences(userId: string): Promise<Record<string, unknown>> {
  const rows = await queryMany<{ prefs: Record<string, unknown> }>(
    'SELECT prefs FROM user_preferences WHERE owner_id = $1',
    [userId],
  );
  return rows[0]?.prefs ?? {};
}

export async function getPreferencesDetailed(userId: string): Promise<{ prefs: Record<string, unknown>; version: number; updatedAt: Date } | null> {
  const rows = await queryMany<{ prefs: Record<string, unknown>; version: number; updated_at: Date }>(
    'SELECT prefs, version, updated_at FROM user_preferences WHERE owner_id = $1',
    [userId],
  );
  if (!rows[0]) return null;
  return { prefs: rows[0].prefs, version: rows[0].version, updatedAt: rows[0].updated_at };
}

export async function updatePreferences(
  userId: string,
  prefs: Record<string, unknown>,
  baseVersion?: number,
): Promise<Record<string, unknown>> {
  const current = await getPreferencesDetailed(userId);
  const merged = { ...(current?.prefs ?? {}), ...prefs };
  if (baseVersion !== undefined) {
    if (current && current.version !== baseVersion) {
      throw AppError.conflict('preferences_conflict', 'Preferences changed on another device', {
        current: { prefs: current.prefs, version: current.version },
      });
    }
  }
  await pool.query(
    `INSERT INTO user_preferences (id, owner_id, prefs, version) VALUES ($1,$2,$3::jsonb, 1)
     ON CONFLICT (owner_id) DO UPDATE
       SET prefs = EXCLUDED.prefs, version = user_preferences.version + 1, updated_at = now()`,
    [newId(PREFIX.PREFERENCE), userId, JSON.stringify(merged)],
  );
  return merged;
}

// ---------------------------------------------------------------- usage counters (server-authoritative)

export interface RecordUsageOptions {
  measured?: boolean;
  unit?: string;
  meta?: Record<string, unknown>;
}

/**
 * Record a usage event. `measured` distinguishes counted reality
 * (messages sent, bytes stored) from estimates (model compute cost).
 * Every event is tenant-scoped (owner_id) and bucketed by day.
 */
export async function recordUsage(
  userId: string,
  name: string,
  quantity: number,
  options: RecordUsageOptions = {},
): Promise<void> {
  const measured = options.measured ?? true;
  const unit = options.unit ?? 'count';
  const day = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO usage_events (id, owner_id, name, bucket, measured, quantity, unit, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [newId(PREFIX.USAGE_EVENT), userId, name, day, measured, quantity, unit, JSON.stringify(options.meta ?? {})],
  );
  if (measured) {
    await pool.query(
      `INSERT INTO usage_counters (id, owner_id, name, bucket, value)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (owner_id, name, bucket) DO UPDATE
         SET value = usage_counters.value + EXCLUDED.value, updated_at = now()`,
      [newId(PREFIX.USAGE_COUNTER), userId, name, day, Math.round(quantity)],
    );
  }
}

export interface UsageOverview {
  plan: PlanId;
  measured: {
    messagesToday: number;
    storageBytes: number;
    aiInputTokens: number;
    aiOutputTokens: number;
    tasksToday: number;
  };
  estimated: {
    computeCostUsd: number;
    sources: number;
  };
  limits: {
    dailyMessages: number;
    maxProjects: number;
    storageGb: number;
  };
  resetDate: string;
}

/**
 * Dashboard payload: measured vs estimated usage and configured limits.
 * No provider call exists in this environment, so compute cost is only
 * ever the sum of explicitly recorded estimated events — never invented.
 */
export async function getUsageOverview(userId: string): Promise<UsageOverview> {
  const today = new Date().toISOString().slice(0, 10);
  const [planRows, eventRows, counterRows] = await Promise.all([
    pool.query('SELECT plan_id FROM users WHERE id = $1', [userId]),
    queryMany<{ name: string; measured: boolean; unit: string; quantity: string; meta: Record<string, unknown> }>(
      `SELECT name, measured, unit, quantity, meta FROM usage_events
       WHERE owner_id = $1 AND bucket = $2`,
      [userId, today],
    ),
    queryMany<{ name: string; value: string | number }>(
      `SELECT name, value FROM usage_counters WHERE owner_id = $1 AND bucket = $2`,
      [userId, today],
    ),
  ]);
  const plan: PlanId = (planRows.rows[0]?.plan_id as PlanId | undefined) ?? 'free';

  const measured = { messagesToday: 0, storageBytes: 0, aiInputTokens: 0, aiOutputTokens: 0, tasksToday: 0 };
  let computeCostUsd = 0;
  let estimatedSources = 0;
  for (const e of eventRows) {
    const q = Number(e.quantity);
    if (e.measured) {
      if (e.name === 'messages') measured.messagesToday += q;
      else if (e.name === 'storage_bytes_used') measured.storageBytes += q;
      else if (e.name === 'ai_input_tokens') measured.aiInputTokens += q;
      else if (e.name === 'ai_output_tokens') measured.aiOutputTokens += q;
      else if (e.name === 'tasks') measured.tasksToday += q;
    } else if (e.name === 'compute_cost_usd') {
      computeCostUsd += q;
      estimatedSources += 1;
    }
  }
  for (const c of counterRows) {
    if (c.name === 'messages') measured.messagesToday = Number(c.value);
    else if (c.name === 'tasks') measured.tasksToday = Number(c.value);
  }

  const storage = await getStorageUsage(userId);
  measured.storageBytes = storage;

  return {
    plan,
    measured,
    estimated: { computeCostUsd, sources: estimatedSources },
    limits: {
      dailyMessages: env.FREE_DAILY_MESSAGES,
      maxProjects: env.FREE_MAX_PROJECTS,
      storageGb: env.FREE_STORAGE_GB,
    },
    resetDate: `${today}T00:00:00.000Z`,
  };
}

export async function incrementUsage(userId: string, name: string, amount = 1, bucket?: string): Promise<number> {
  const day = bucket ?? new Date().toISOString().slice(0, 10);
  const result = await pool.query(
    `INSERT INTO usage_counters (id, owner_id, name, bucket, value)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (owner_id, name, bucket) DO UPDATE
       SET value = usage_counters.value + EXCLUDED.value, updated_at = now()
     RETURNING value`,
    [newId(PREFIX.USAGE_COUNTER), userId, name, day, amount],
  );
  return Number(result.rows[0]?.value ?? 0);
}

export async function getUsage(userId: string): Promise<Record<string, number>> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await queryMany<{ name: string; value: string | number }>(
    `SELECT name, value FROM usage_counters WHERE owner_id = $1 AND bucket = $2`,
    [userId, today],
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[row.name] = Number(row.value);
  if (!('date' in out)) Object.assign(out, { date: 0 });
  return out;
}

export async function getStorageUsage(userId: string): Promise<number> {
  const rows = await queryMany<{ value: string | number }>(
    `SELECT COALESCE(SUM(value), 0) AS value FROM usage_counters
     WHERE owner_id = $1 AND name = 'storage_bytes_used'`,
    [userId],
  );
  return Number(rows[0]?.value ?? 0);
}

// ---------------------------------------------------------------- free limit checks

export interface FreeLimitCheck {
  ok: boolean;
  reason: string | null;
  usage: Record<string, number>;
  limits: Record<string, number>;
  plan: PlanId;
}

export async function checkFreeLimits(userId: string, kind: 'message' | 'project' | 'storage'): Promise<FreeLimitCheck> {
  const user = await pool.query('SELECT plan_id FROM users WHERE id = $1', [userId]);
  const plan: PlanId = (user.rows[0]?.plan_id as PlanId | undefined) ?? 'free';
  const usage = await getUsage(userId);
  const limits = {
    dailyMessages: env.FREE_DAILY_MESSAGES,
    maxProjects: env.FREE_MAX_PROJECTS,
    storageGb: env.FREE_STORAGE_GB,
  };

  if (plan === 'pro' || plan === 'team' || plan === 'enterprise') return { ok: true, reason: null, usage, limits, plan };
  if (kind === 'message' && (usage.daily_messages ?? 0) >= limits.dailyMessages) {
    return { ok: false, reason: 'daily_message_limit', usage, limits, plan };
  }
  if (kind === 'project') {
    const count = await pool.query(
      'SELECT count(*)::int AS n FROM projects WHERE owner_id = $1 AND deleted_at IS NULL',
      [userId],
    );
    if ((count.rows[0]?.n ?? 0) >= limits.maxProjects) {
      return { ok: false, reason: 'project_limit', usage, limits, plan };
    }
  }
  if (kind === 'storage') {
    const storage = await getStorageUsage(userId);
    if (storage >= limits.storageGb * 1024 * 1024 * 1024) {
      return { ok: false, reason: 'storage_limit', usage, limits, plan };
    }
  }
  return { ok: true, reason: null, usage, limits, plan };
}

/** Records the free-limit transition so the Moon moment shows exactly once. */
export async function shouldShowFreeLimitMoon(userId: string): Promise<boolean> {
  const key = `moon:${userId}:${new Date().toISOString().slice(0, 10)}`;
  const seen = await cache.get(key);
  if (seen) return false;
  await cache.set(key, '1', 24 * 60 * 60 * 1000);
  return true;
}

// ---------------------------------------------------------------- feature flags (server-side only)

export async function getFeatureFlags(): Promise<Record<string, boolean>> {
  const rows = await queryMany<{ name: string; value: Record<string, unknown> }>('SELECT name, value FROM feature_flags');
  const out: Record<string, boolean> = {};
  for (const row of rows) out[row.name] = Boolean(row.value?.value ?? true);
  return out;
}

// ---------------------------------------------------------------- context indicator + return to work

export async function contextIndicator(userId: string): Promise<Record<string, unknown>> {
  const lastProject = await getWorkspaceState(userId, WorkspaceStateKey.LAST_ACTIVE_PROJECT);
  const memoryCount = await pool.query(
    'SELECT count(*)::int AS n FROM memories WHERE owner_id = $1 AND deleted_at IS NULL',
    [userId],
  );
  const dnaCount = await pool.query(
    'SELECT count(*)::int AS n FROM dna WHERE owner_id = $1 AND deleted_at IS NULL',
    [userId],
  );
  const dnaVersion = await pool.query(
    'SELECT max(version)::int AS v FROM dna WHERE owner_id = $1 AND deleted_at IS NULL',
    [userId],
  );
  const memorySourceRefs = await pool.query(
    `SELECT count(DISTINCT provenance)::int AS n FROM memories
     WHERE owner_id = $1 AND deleted_at IS NULL AND provenance IS NOT NULL`,
    [userId],
  );
  const lastProjectFileCount = lastProject?.projectId
    ? await pool.query(
        'SELECT count(*)::int AS n FROM files WHERE owner_id = $1 AND project_id = $2 AND deleted_at IS NULL',
        [userId, lastProject.projectId],
      )
    : null;
  return {
    memoryLoaded: (memoryCount.rows[0]?.n ?? 0) > 0,
    memoryCount: memoryCount.rows[0]?.n ?? 0,
    memorySourceRefs: memorySourceRefs.rows[0]?.n ?? 0,
    dnaCount: dnaCount.rows[0]?.n ?? 0,
    dnaVersion: dnaVersion.rows[0]?.v ?? 0,
    project: lastProject ?? null,
    relevantFiles: lastProjectFileCount?.rows[0]?.n ?? 0,
  };
}