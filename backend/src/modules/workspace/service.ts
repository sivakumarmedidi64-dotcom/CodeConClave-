/**
 * CodeConClave — workspace module.
 * workspace_state (continuity + multi-device reconciliation), user_preferences,
 * usage counters (server-authoritative free limits), feature flags, context
 * indicator. Return-to-work summaries live in the returnToWork module.
 */
import { withSystem, pool, withTenant, queryMany } from '../../shared/db.js';
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
    const result = await withTenant(userId, (q) => q.query(
      `UPDATE workspace_state SET value = $3::jsonb, version = version + 1, updated_at = now()
       WHERE owner_id = $1 AND key = $2 AND version = $4
       RETURNING key, value, version, updated_at`,
      [userId, key, JSON.stringify(value), baseVersion],
    ));
    const row = result.rows[0] as WorkspaceStateRow | undefined;
    if (!row) {
      // P0-2: the conflict re-read is owner-scoped and runs inside a tenant
      // transaction, so the tenant context is established for the read itself
      // rather than relying on the failed UPDATE to have implied it.
      const current = await withTenant(userId, (q) =>
        q.query<WorkspaceStateRow>(
          'SELECT key, value, version, updated_at FROM workspace_state WHERE owner_id = $1 AND key = $2',
          [userId, key],
        ),
      ).then((r) => r.rows);
      throw AppError.conflict('workspace_conflict', 'Workspace state changed on another device', {
        current: current[0]
          ? { key: current[0].key, value: current[0].value, version: current[0].version, updatedAt: current[0].updated_at }
          : null,
      });
    }
    return { key: row.key, value: row.value, version: row.version, updatedAt: row.updated_at };
  }
  const result = await withTenant(userId, (q) => q.query(
    `INSERT INTO workspace_state (id, owner_id, key, value, version)
     VALUES ($1,$2,$3,$4::jsonb, 1)
     ON CONFLICT (owner_id, key) DO UPDATE
       SET value = EXCLUDED.value, version = workspace_state.version + 1, updated_at = now()
     RETURNING key, value, version, updated_at`,
    [newId(PREFIX.WORKSPACE), userId, key, JSON.stringify(value)],
  ));
  const row = result.rows[0] as WorkspaceStateRow | undefined;
  return row
    ? { key: row.key, value: row.value, version: row.version, updatedAt: row.updated_at }
    : { key, value, version: 1, updatedAt: new Date() };
}

export async function getWorkspaceState(userId: string, key: string): Promise<Record<string, unknown> | null> {
  const rows = await withTenant(userId, (q) =>
    q.query<{ value: Record<string, unknown> }>(
      'SELECT value FROM workspace_state WHERE owner_id = $1 AND key = $2',
      [userId, key],
    ),
  ).then((r) => r.rows);
  return rows[0]?.value ?? null;
}

export async function getWorkspaceStateDetailed(userId: string, key: string): Promise<WorkspaceStateEntry | null> {
  const rows = await withTenant(userId, (q) =>
    q.query<WorkspaceStateRow>(
      'SELECT key, value, version, updated_at FROM workspace_state WHERE owner_id = $1 AND key = $2',
      [userId, key],
    ),
  ).then((r) => r.rows);
  if (!rows[0]) return null;
  return { key: rows[0].key, value: rows[0].value, version: rows[0].version, updatedAt: rows[0].updated_at };
}

export async function listWorkspaceState(userId: string): Promise<WorkspaceStateEntry[]> {
  const rows = await withTenant(userId, (q) =>
    q.query<WorkspaceStateRow>(
      'SELECT key, value, version, updated_at FROM workspace_state WHERE owner_id = $1 ORDER BY updated_at DESC',
      [userId],
    ),
  ).then((r) => r.rows);
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
  const rows = await withTenant(userId, (q) =>
    q.query<{ prefs: Record<string, unknown> }>('SELECT prefs FROM user_preferences WHERE owner_id = $1', [userId]),
  ).then((r) => r.rows);
  return rows[0]?.prefs ?? {};
}

export async function getPreferencesDetailed(userId: string): Promise<{ prefs: Record<string, unknown>; version: number; updatedAt: Date } | null> {
  const rows = await withTenant(userId, (q) =>
    q.query<{ prefs: Record<string, unknown>; version: number; updated_at: Date }>(
      'SELECT prefs, version, updated_at FROM user_preferences WHERE owner_id = $1',
      [userId],
    ),
  ).then((r) => r.rows);
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
  await withTenant(userId, (q) => q.query(
    `INSERT INTO user_preferences (id, owner_id, prefs, version) VALUES ($1,$2,$3::jsonb, 1)
     ON CONFLICT (owner_id) DO UPDATE
       SET prefs = EXCLUDED.prefs, version = user_preferences.version + 1, updated_at = now()`,
    [newId(PREFIX.PREFERENCE), userId, JSON.stringify(merged)],
  ));
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
  await withTenant(userId, (q) => q.query(
    `INSERT INTO usage_events (id, owner_id, name, bucket, measured, quantity, unit, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [newId(PREFIX.USAGE_EVENT), userId, name, day, measured, quantity, unit, JSON.stringify(options.meta ?? {})],
  ));
  if (measured) {
    await withTenant(userId, (q) => q.query(
      `INSERT INTO usage_counters (id, owner_id, name, bucket, value)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (owner_id, name, bucket) DO UPDATE
         SET value = usage_counters.value + EXCLUDED.value, updated_at = now()`,
      [newId(PREFIX.USAGE_COUNTER), userId, name, day, Math.round(quantity)],
    ));
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
  rolling: {
    used: number;
    limit: number;
    windowHours: number;
    windowStart: string | null;
    resetsAt: string | null;
    remaining: number;
  };
}

/**
 * Dashboard payload: measured vs estimated usage and configured limits.
 * No provider call exists in this environment, so compute cost is only
 * ever the sum of explicitly recorded estimated events — never invented.
 */
export async function getUsageOverview(userId: string): Promise<UsageOverview> {
  const today = new Date().toISOString().slice(0, 10);
  // P0-2: the three reads share ONE tenant transaction so the plan, event and
  // counter snapshots cannot be taken under different tenant contexts.
  const { planRows, eventRows, counterRows } = await withTenant(
    userId,
    async (q) => {
      const [plan, events, counters] = await Promise.all([
        q.query('SELECT plan_id FROM users WHERE id = $1', [userId]),
        q.query<{ name: string; measured: boolean; unit: string; quantity: string; meta: Record<string, unknown> }>(
          `SELECT name, measured, unit, quantity, meta FROM usage_events
           WHERE owner_id = $1 AND bucket = $2`,
          [userId, today],
        ),
        q.query<{ name: string; value: string | number }>(
          `SELECT name, value FROM usage_counters WHERE owner_id = $1 AND bucket = $2`,
          [userId, today],
        ),
      ]);
      return { planRows: plan, eventRows: events.rows, counterRows: counters.rows };
    },
  );
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
  const rolling = await getRollingFreeUsage(userId);

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
    rolling: {
      used: rolling.used,
      limit: rolling.limit,
      windowHours: rolling.windowHours,
      windowStart: rolling.windowStart,
      resetsAt: rolling.resetsAt,
      remaining: rolling.remaining,
    },
  };
}

export async function incrementUsage(userId: string, name: string, amount = 1, bucket?: string): Promise<number> {
  const day = bucket ?? new Date().toISOString().slice(0, 10);
  const result = await withTenant(userId, (q) => q.query(
    `INSERT INTO usage_counters (id, owner_id, name, bucket, value)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (owner_id, name, bucket) DO UPDATE
       SET value = usage_counters.value + EXCLUDED.value, updated_at = now()
     RETURNING value`,
    [newId(PREFIX.USAGE_COUNTER), userId, name, day, amount],
  ));
  return Number(result.rows[0]?.value ?? 0);
}

export async function getUsage(userId: string): Promise<Record<string, number>> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await withTenant(userId, (q) =>
    q.query<{ name: string; value: string | number }>(
      `SELECT name, value FROM usage_counters WHERE owner_id = $1 AND bucket = $2`,
      [userId, today],
    ),
  ).then((r) => r.rows);
  const out: Record<string, number> = {};
  for (const row of rows) out[row.name] = Number(row.value);
  if (!('date' in out)) Object.assign(out, { date: 0 });
  return out;
}

export async function getStorageUsage(userId: string): Promise<number> {
  const rows = await withTenant(userId, (q) =>
    q.query<{ value: string | number }>(
      `SELECT COALESCE(SUM(value), 0) AS value FROM usage_counters
       WHERE owner_id = $1 AND name = 'storage_bytes_used'`,
      [userId],
    ),
  ).then((r) => r.rows);
  return Number(rows[0]?.value ?? 0);
}

// ---------------------------------------------------------------- rolling usage window

export interface RollingUsageInfo {
  used: number;
  limit: number;
  windowHours: number;
  windowStart: string | null;
  resetsAt: string | null;
  remaining: number;
}

function surfaceRolling(row: { used: number | string | null; window_start: Date | string | null } | null): RollingUsageInfo {
  const limit = env.FREE_DAILY_MESSAGES;
  const windowHours = env.FREE_USAGE_WINDOW_HOURS;
  if (!row) {
    return { used: 0, limit, windowHours, windowStart: null, resetsAt: null, remaining: limit };
  }
  const windowStart = row.window_start == null ? null : new Date(row.window_start).toISOString();
  const used = Number(row.used ?? 0);
  let remaining = Math.max(0, limit - used);
  let resetsAt: string | null = null;
  if (row.window_start != null) {
    const start = new Date(row.window_start);
    const resets = new Date(start.getTime() + windowHours * 3600_000);
    resetsAt = resets.toISOString();
    if (resets.getTime() <= Date.now()) remaining = Math.max(0, limit - used);
  }
  return { used, limit, windowHours, windowStart, resetsAt, remaining };
}

export async function getRollingFreeUsage(userId: string): Promise<RollingUsageInfo> {
  const result = await withTenant(userId, (q) =>
    q.query<{ used: number; window_start: Date | string | null }>(
      `SELECT used, window_start FROM free_usage_windows WHERE owner_id = $1`,
      [userId],
    ),
  );
  return surfaceRolling(result.rows[0] ?? null);
}

export interface ConsumeFreeMessageResult {
  accepted: boolean;
  usage: RollingUsageInfo;
}

/**
 * Atomically consumes one message from the free rolling window. A single
 * UPSERT resets an expired window (used -> 1, window_start -> now()) and only
 * increments when used < limit, so concurrent requests cannot overshoot.
 */
export async function consumeFreeMessage(userId: string): Promise<ConsumeFreeMessageResult> {
  const windowHours = env.FREE_USAGE_WINDOW_HOURS;
  const limit = env.FREE_DAILY_MESSAGES;
  const result = await pool.query<{ used: number; window_start: Date | string | null }>(
    `INSERT INTO free_usage_windows (owner_id, window_start, used, updated_at)
     VALUES ($1, now(), 1, now())
     ON CONFLICT (owner_id) DO UPDATE
       SET used = CASE WHEN free_usage_windows.window_start IS NULL
                            OR now() - free_usage_windows.window_start >= make_interval(hours => $2)
                        THEN 1
                        ELSE free_usage_windows.used + 1 END,
           window_start = CASE WHEN free_usage_windows.window_start IS NULL
                                    OR now() - free_usage_windows.window_start >= make_interval(hours => $2)
                                THEN now()
                                ELSE free_usage_windows.window_start END,
           updated_at = now()
       WHERE free_usage_windows.window_start IS NULL
          OR now() - free_usage_windows.window_start >= make_interval(hours => $2)
          OR free_usage_windows.used < $3
     RETURNING used, window_start`,
    [userId, windowHours, limit],
  );
  if (!result.rows[0]) {
    return { accepted: false, usage: await getRollingFreeUsage(userId) };
  }
  return { accepted: true, usage: surfaceRolling(result.rows[0]) };
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
  const user = await withTenant(userId, (q) => q.query('SELECT plan_id FROM users WHERE id = $1', [userId]));
  const plan: PlanId = (user.rows[0]?.plan_id as PlanId | undefined) ?? 'free';
  const usage = await getUsage(userId);
  const limits = {
    dailyMessages: env.FREE_DAILY_MESSAGES,
    maxProjects: env.FREE_MAX_PROJECTS,
    storageGb: env.FREE_STORAGE_GB,
  };

  if (plan === 'pro' || plan === 'team' || plan === 'enterprise') return { ok: true, reason: null, usage, limits, plan };
  if (kind === 'message') {
    const rolling = await getRollingFreeUsage(userId);
    if (rolling.remaining <= 0) {
      return { ok: false, reason: 'daily_message_limit', usage, limits, plan };
    }
  }
  if (kind === 'project') {
    const count = await withTenant(userId, (q) =>
      q.query(
        'SELECT count(*)::int AS n FROM projects WHERE owner_id = $1 AND deleted_at IS NULL',
        [userId],
      ),
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

/** Records the free-limit transition so the Moon moment shows once per rolling window. */
export async function shouldShowFreeLimitMoon(userId: string): Promise<boolean> {
  const rolling = await getRollingFreeUsage(userId);
  const windowId = rolling.windowStart ?? 'none';
  const key = `moon:${userId}:${windowId}`;
  const seen = await cache.get(key);
  if (seen) return false;
  await cache.set(key, '1', 24 * 60 * 60 * 1000);
  return true;
}

// ---------------------------------------------------------------- feature flags (server-side only)

export async function getFeatureFlags(): Promise<Record<string, boolean>> {
  const rows = await withSystem<{ name: string; value: Record<string, unknown> }[]>(async (q) =>
    (await q.query<{ name: string; value: Record<string, unknown> }>('SELECT name, value FROM feature_flags')).rows,
  );
  const out: Record<string, boolean> = {};
  for (const row of rows) out[row.name] = Boolean(row.value?.value ?? true);
  return out;
}

// ---------------------------------------------------------------- context indicator + return to work

export async function contextIndicator(userId: string): Promise<Record<string, unknown>> {
  const lastProject = await getWorkspaceState(userId, WorkspaceStateKey.LAST_ACTIVE_PROJECT);
  // P0-2: all four context counters plus the optional project file count run in
  // a single tenant transaction, so the indicator can never mix two owners'
  // counts and the tenant context is set for every statement.
  const { memoryCount, dnaCount, dnaVersion, memorySourceRefs, lastProjectFileCount } = await withTenant(
    userId,
    async (q) => {
      const [memories, dnaRows, dnaMax, sources, files] = await Promise.all([
        q.query('SELECT count(*)::int AS n FROM memories WHERE owner_id = $1 AND deleted_at IS NULL', [userId]),
        q.query('SELECT count(*)::int AS n FROM dna WHERE owner_id = $1 AND deleted_at IS NULL', [userId]),
        q.query('SELECT max(version)::int AS v FROM dna WHERE owner_id = $1 AND deleted_at IS NULL', [userId]),
        q.query(
          `SELECT count(DISTINCT provenance)::int AS n FROM memories
           WHERE owner_id = $1 AND deleted_at IS NULL AND provenance IS NOT NULL`,
          [userId],
        ),
        lastProject?.projectId
          ? q.query(
              'SELECT count(*)::int AS n FROM files WHERE owner_id = $1 AND project_id = $2 AND deleted_at IS NULL',
              [userId, lastProject.projectId],
            )
          : Promise.resolve(null),
      ]);
      return {
        memoryCount: memories,
        dnaCount: dnaRows,
        dnaVersion: dnaMax,
        memorySourceRefs: sources,
        lastProjectFileCount: files,
      };
    },
  );
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