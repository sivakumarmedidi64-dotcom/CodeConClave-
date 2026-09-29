/**
 * CodeConClave — P0-2 Phase 1: tenant-isolation baseline.
 *
 * This is a MEASUREMENT, not a claim of isolation. It enumerates every table
 * created by the migration set and classifies how it is currently protected so
 * the staged migration has an explicit work list.
 *
 * Why this exists: 356 RLS policies key on `app.uid()`, but only a small number
 * of query paths establish `app.current_user_id` (via withTenant/withSystem).
 * Every other path issues a bare `pool.query` via queryOne/queryMany. Because
 * the runtime role currently owns its tables, RLS is bypassed for those queries
 * and they work. If FORCE ROW LEVEL SECURITY were enabled before the query layer
 * is migrated, `app.uid()` would resolve to NULL and those same queries would
 * silently return zero rows instead of failing loudly.
 *
 * So the correct sequence is: measure -> migrate query paths -> separate
 * runtime role -> enable FORCE RLS. This file produces the "measure" artifact.
 *
 * The classification is derived from the migration SQL itself (table names,
 * RLS enablement, and policy ownership columns), so it stays honest as the
 * schema evolves instead of drifting from a hand-maintained list.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..', '..', '..');
const migrationsDir = join(repoRoot, 'database', 'migrations');

type Classification = 'tenant' | 'system' | 'global' | 'unknown';

interface TableFacts {
  table: string;
  rlsEnabled: boolean;
  policyCount: number;
  /** Columns a policy compares against app.uid() / team membership. */
  ownershipColumns: string[];
}

function readMigrations(): string {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
    .join('\n');
}

const SQL = readMigrations();

const CREATED = [...SQL.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-zA-Z0-9_]+)/gi)].map(
  (m) => m[1].toLowerCase(),
);
const UNIQUE_TABLES = [...new Set(CREATED)].sort();

const RLS_ENABLED = new Set(
  [...SQL.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?([a-zA-Z0-9_]+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)].map(
    (m) => m[1].toLowerCase(),
  ),
);

const FORCED = new Set(
  [...SQL.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?([a-zA-Z0-9_]+)\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi)].map(
    (m) => m[1].toLowerCase(),
  ),
);

const POLICY_COUNTS = new Map<string, number>();
for (const m of SQL.matchAll(/CREATE\s+POLICY\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-zA-Z0-9_"]+\s+ON\s+(?:public\.)?([a-zA-Z0-9_]+)/gi)) {
  const t = m[1].toLowerCase();
  POLICY_COUNTS.set(t, (POLICY_COUNTS.get(t) ?? 0) + 1);
}

/** Ownership columns referenced by policies, used to infer the scope model. */
const OWNERSHIP_COLUMN = /\b(user_id|owner_id|actor_user_id|tenant_id|requested_by|member_id|created_by|author_id)\b/gi;

function factsFor(table: string): TableFacts {
  const ownershipColumns = new Set<string>();
  const policyRe = new RegExp(
    `CREATE\\s+POLICY[^;]*?ON\\s+(?:public\\.)?${table}\\b[\\s\\S]{0,400}?;`,
    'gi',
  );
  for (const m of SQL.matchAll(policyRe)) {
    for (const c of m[0].matchAll(OWNERSHIP_COLUMN)) {
      ownershipColumns.add(c[1].toLowerCase());
    }
  }
  return {
    table,
    rlsEnabled: RLS_ENABLED.has(table),
    policyCount: POLICY_COUNTS.get(table) ?? 0,
    ownershipColumns: [...ownershipColumns],
  };
}

/**
 * Tables that are deliberately global: reference data or infrastructure state
 * that is not owned by a user and is only reachable through service code.
 * Each entry carries the reason it does not need per-tenant RLS.
 */
const GLOBAL_TABLES: Record<string, string> = {
  schema_migrations: 'migration ledger, written only by the migrator',
  ai_model_registry: 'global model catalogue',
  provider_health: 'global provider health cache',
  feature_flags: 'global configuration',
  plugins: 'global plugin catalogue',
  agent_catalogue: 'global agent catalogue',
  compute_policy: 'global infrastructure policy',
  api_security_config: 'global scanner configuration',
  cost_alerts: 'global cost alerting thresholds',
  cost_entries: 'global cost ledger, not user content',
  db_performance_log: 'global operational metrics',
  db_performance_reports: 'global operational metrics',
  http_requests: 'global operational metrics',
  performance_metrics: 'global operational metrics',
  query_performance_log: 'global operational metrics',
  technical_debt_log: 'global engineering metadata',
  events: 'global event bus',
  monitoring_autopilot_config: 'global configuration',
  runtime_console_events: 'operational diagnostics, not user content',
  runtime_executions: 'operational diagnostics, not user content',
  runtime_network_events: 'operational diagnostics, not user content',
  runtime_smoke_results: 'operational diagnostics, not user content',
  runtime_smoke_runs: 'operational diagnostics, not user content',
  runtime_background_tasks: 'operational job state',
  provider_health_cache: 'global provider health cache',
  security_posture_cache: 'global derived cache',
  security_posture_history: 'global derived history',
  suppression_rules: 'global scanner configuration',
  outbox_events: 'system outbox drained by workers, not user content',
  idem_pool: 'internal pool bookkeeping',
  payment_reconciliation: 'system reconciliation run state, not user content',
  payment_webhook_events: 'provider event log keyed by provider id, not user content',
  payment_auto_approvals: 'founder/ops approval policy state',
  payment_unlock_settings: 'global payment policy',
  secret_rotation_policies: 'global security policy',
  secops_compliance_reports: 'global compliance output',
  supply_chain_scans: 'global scan results',
};

/**
 * Tables explicitly written by system/background code with no per-user row
 * ownership. These are NOT global user data; they are recorded by services and
 * must remain reachable without a tenant context, so FORCE RLS must never be
 * applied to them blindly.
 */
const SYSTEM_TABLES: Record<string, string> = {
  audit_logs: 'append-only security/audit trail written by every request',
  db_migrations_lock: 'migration concurrency guard',
  outbox_events: 'system outbox drained by workers',
  payment_reconciliation: 'system reconciliation run state',
  payment_webhook_events: 'provider event log, written by the webhook receiver',
  payment_auto_approvals: 'ops approval policy state',
  payment_unlock_settings: 'global payment policy',
  runtime_background_tasks: 'background job state',
  runtime_console_events: 'operational diagnostics',
  schema_migrations: 'migration ledger',
};

function classify(table: string): { scope: Classification; reason: string } {
  if (table in GLOBAL_TABLES) return { scope: 'global', reason: GLOBAL_TABLES[table] };
  if (table in SYSTEM_TABLES) return { scope: 'system', reason: SYSTEM_TABLES[table] };
  const facts = factsFor(table);
  if (facts.policyCount > 0 && facts.ownershipColumns.length > 0) {
    return {
      scope: 'tenant',
      reason: `policies compare ${facts.ownershipColumns.join(', ')} against app.uid()`,
    };
  }
  return { scope: 'unknown', reason: 'no policy with an ownership column; needs owner analysis' };
}

const ALL: TableFacts[] = UNIQUE_TABLES.map(factsFor);
const CLASSIFIED = new Map(UNIQUE_TABLES.map((t) => [t, classify(t)]));

function countBy(scope: Classification): number {
  return UNIQUE_TABLES.filter((t) => CLASSIFIED.get(t)?.scope === scope).length;
}

/** High-risk tenant resources named in the launch audit, checked explicitly. */
const HIGH_RISK = [
  'user_api_keys',
  'workspaces',
  'workspace_shares',
  'payment_claims',
  'workspace_edits',
  'workspace_tabs',
  'workspace_reviews',
  'dev_preferences',
  'secret_exposures',
];

describe('P0-2 Phase 1 — tenant isolation baseline', () => {
  it('discovers the full table inventory from the migration set', () => {
    expect(UNIQUE_TABLES.length).toBeGreaterThan(300);
  });

  it('reports FORCE RLS is not yet enabled anywhere (Phase 7 gate)', () => {
    // Non-zero here means FORCE was enabled before the query layer was migrated,
    // which would silently zero out unscoped queries. This assertion exists to
    // make that mistake loud instead of subtle.
    expect(FORCED.size).toBe(0);
  });

  it('classifies every table into a bounded scope with a reason', () => {
    const unknown = UNIQUE_TABLES.filter((t) => CLASSIFIED.get(t)?.scope === 'unknown');
    // Every table must be deliberately classified or explicitly unknown; the
    // Phase 2 backlog is exactly this unknown set plus the unscoped query paths.
    for (const t of unknown) {
      expect(CLASSIFIED.get(t)?.reason).toMatch(/needs owner analysis/);
    }
    expect(countBy('tenant') + countBy('system') + countBy('global') + countBy('unknown')).toBe(
      UNIQUE_TABLES.length,
    );
  });

  it('flags every RLS-enabled table as FORCE-able only after migration', () => {
    const rlsTables = ALL.filter((t) => t.rlsEnabled);
    expect(rlsTables.length).toBeGreaterThan(200);
    for (const t of rlsTables) {
      expect(FORCED.has(t.table)).toBe(false);
    }
  });

  it('records the high-risk audit tables and their current state', () => {
    const report = HIGH_RISK.map((t) => {
      const facts = factsFor(t);
      return {
        table: t,
        rls: facts.rlsEnabled,
        policies: facts.policyCount,
        scope: CLASSIFIED.get(t)?.scope ?? 'missing',
      };
    });
    // MEASURED, not assumed: user_api_keys has no RLS and no policy today. It is
    // protected only by the app-layer owner_id filter in apikeys/service.ts, so it
    // is the first Phase 2 target. This assertion pins the measurement so a
    // future migration has to change the test deliberately.
    const apiKeys = report.find((r) => r.table === 'user_api_keys');
    expect(apiKeys?.rls).toBe(false);
    expect(apiKeys?.policies).toBe(0);
    // The Phase 2 backlog must be visible rather than assumed.
    for (const entry of report) {
      expect(entry.scope).not.toBe('missing');
    }
  });

  it('emits a migration backlog artifact', () => {
    const backlog = {
      totalTables: UNIQUE_TABLES.length,
      tenantScoped: countBy('tenant'),
      systemScoped: countBy('system'),
      global: countBy('global'),
      unknownNeedsOwnerAnalysis: countBy('unknown'),
      rlsEnabledNotForced: ALL.filter((t) => t.rlsEnabled).length,
      forceRlsApplied: FORCED.size,
    };
    process.stdout.write(`[p0-2-baseline] ${JSON.stringify(backlog)}\n`);
    expect(backlog.totalTables).toBe(UNIQUE_TABLES.length);
    expect(backlog.forceRlsApplied).toBe(0);
  });
});
