/**
 * CodeConClave — permission rules (allow / ask / deny), Article 1 of the
 * CodeConClave constitution. Borrowed from Claude Code's permission rules,
 * Zed's tool permissions, Continue's tool policies and Devin's CLI rules,
 * then adjusted so they can never weaken the immutable baseline:
 *
 *   deny  → the matching action is blocked
 *   ask   → the matching action always asks first (overrides Auto-accept/Auto)
 *   allow → a matching LOW/MEDIUM action skips the prompt
 *
 * Precedence is deny > ask > allow. A rule never turns a baseline denial
 * (secrets, dangerous commands, traversal, missing grants) into an allow, and
 * `allow` never waives a delete or a HIGH/CRITICAL action.
 *
 * Like the permission mode, rules live in a small cache that authenticated
 * requests refresh (the policy engine is synchronous). A cache miss means "no
 * rules", which is the baseline behaviour — never something looser.
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';

export const RULE_EFFECTS = ['allow', 'ask', 'deny'] as const;
export type RuleEffect = (typeof RULE_EFFECTS)[number];

/** Tools a rule can name ('*' = any tool). Mirrors execution/policy.ts. */
export const RULE_TOOLS = [
  '*',
  'file_read',
  'file_list',
  'file_write',
  'file_create',
  'file_delete',
  'terminal_exec',
  'network_request',
  'browser_open',
  'plugin_action',
  'local_list',
  'local_read',
  'local_write',
  'local_exec',
  'mcp_call',
] as const;
export type RuleTool = (typeof RULE_TOOLS)[number];

export const MAX_RULES = 100;

export interface PermissionRule {
  id: string;
  effect: RuleEffect;
  tool: RuleTool;
  pattern: string;
  note: string | null;
  createdAt: string;
}

const TTL_MS = 15_000;
const cache = new Map<string, { rules: PermissionRule[]; at: number }>();

/** Synchronous read for the policy engine (no rules when unknown). */
export function permissionRulesFor(userId: string): PermissionRule[] {
  return cache.get(userId)?.rules ?? [];
}

/** True when the cached rules are older than the refresh TTL. */
export function rulesStale(userId: string): boolean {
  const c = cache.get(userId);
  return !c || Date.now() - c.at > TTL_MS;
}

/** Test hook: seed the cache without a database. */
export function _setRulesForTest(userId: string, rules: PermissionRule[]): void {
  cache.set(userId, { rules, at: Date.now() });
}

// ---------------------------------------------------------------- matching

/**
 * Glob → RegExp. `*` matches any run of characters (including "/"), `?` one
 * character; everything else is literal. Paths are compared with forward
 * slashes; commands with collapsed whitespace. Case-insensitive, so a rule
 * written for `src/*` also covers `SRC/` on Windows.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (const ch of glob) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

/** What a rule's pattern is compared against for each tool. */
export function ruleSubject(tool: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (tool) {
    case 'terminal_exec':
    case 'local_exec':
      return s(input.command).trim().replace(/\s+/g, ' ');
    case 'network_request':
    case 'browser_open':
      return s(input.url).trim();
    case 'plugin_action':
      return `${s(input.pluginType)}:${s(input.action)}`;
    case 'mcp_call':
      return `${s(input.server)}/${s(input.tool)}`;
    default:
      return (s(input.path) || s(input.filePath)).replace(/\\/g, '/').replace(/^\.\//, '');
  }
}

export function ruleMatches(rule: Pick<PermissionRule, 'tool' | 'pattern'>, tool: string, subject: string): boolean {
  if (rule.tool !== '*' && rule.tool !== tool) return false;
  const pattern = rule.tool === 'terminal_exec' || rule.tool === 'local_exec' ? rule.pattern.trim().replace(/\s+/g, ' ') : rule.pattern.replace(/\\/g, '/');
  return globToRegExp(pattern).test(subject);
}

/** The strongest matching rule (deny > ask > allow), or null. */
export function strongestRule(rules: PermissionRule[], tool: string, input: Record<string, unknown>): PermissionRule | null {
  const subject = ruleSubject(tool, input);
  let best: PermissionRule | null = null;
  const rank: Record<RuleEffect, number> = { deny: 3, ask: 2, allow: 1 };
  for (const r of rules) {
    if (!ruleMatches(r, tool, subject)) continue;
    if (!best || rank[r.effect] > rank[best.effect]) best = r;
  }
  return best;
}

// ---------------------------------------------------------------- storage

function rowToRule(r: { id: string; effect: string; tool: string; pattern: string; note: string | null; created_at: Date | string }): PermissionRule {
  return {
    id: r.id,
    effect: r.effect as RuleEffect,
    tool: r.tool as RuleTool,
    pattern: r.pattern,
    note: r.note,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function loadPermissionRules(userId: string): Promise<PermissionRule[]> {
  const rows = await withTenant(userId, async (q) =>
    (
      await q.query<{ id: string; effect: string; tool: string; pattern: string; note: string | null; created_at: Date }>(
        `SELECT id, effect, tool, pattern, note, created_at FROM user_permission_rules WHERE user_id = $1 ORDER BY created_at, id`,
        [userId],
      )
    ).rows,
  );
  const rules = rows.map(rowToRule);
  cache.set(userId, { rules, at: Date.now() });
  return rules;
}

export function validateRuleInput(body: unknown): { effect: RuleEffect; tool: RuleTool; pattern: string; note: string | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  const effect = b.effect;
  const tool = b.tool;
  const pattern = typeof b.pattern === 'string' ? b.pattern.trim() : '';
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 200) : null;
  if (typeof effect !== 'string' || !(RULE_EFFECTS as readonly string[]).includes(effect)) {
    throw AppError.badRequest('invalid_rule_effect', 'effect must be allow, ask or deny');
  }
  if (typeof tool !== 'string' || !(RULE_TOOLS as readonly string[]).includes(tool)) {
    throw AppError.badRequest('invalid_rule_tool', `tool must be one of ${RULE_TOOLS.join(', ')}`);
  }
  if (!pattern || pattern.length > 300) {
    throw AppError.badRequest('invalid_rule_pattern', 'pattern is required (up to 300 characters)');
  }
  // A blanket allow would silently turn every prompt off — refuse it; people
  // who want that pick Auto mode, which still keeps deletes and HIGH risk asking.
  if (effect === 'allow' && tool === '*' && /^\*+$/.test(pattern)) {
    throw AppError.badRequest('rule_too_broad', 'An allow rule for every tool and every target is too broad. Use Auto mode instead, or name a tool and pattern.');
  }
  return { effect: effect as RuleEffect, tool: tool as RuleTool, pattern, note };
}

export async function addPermissionRule(userId: string, body: unknown): Promise<PermissionRule> {
  const input = validateRuleInput(body);
  const id = newId('prl');
  const row = await withTenant(userId, async (q) => {
    const count = Number((await q.query<{ n: string }>('SELECT count(*)::text AS n FROM user_permission_rules WHERE user_id = $1', [userId])).rows[0]?.n ?? 0);
    if (count >= MAX_RULES) throw AppError.badRequest('too_many_rules', `You can keep up to ${MAX_RULES} rules.`);
    return (
      await q.query<{ id: string; effect: string; tool: string; pattern: string; note: string | null; created_at: Date }>(
        `INSERT INTO user_permission_rules (id, user_id, effect, tool, pattern, note) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, effect, tool, pattern, note, created_at`,
        [id, userId, input.effect, input.tool, input.pattern, input.note],
      )
    ).rows[0]!;
  });
  await loadPermissionRules(userId);
  await recordAudit({
    action: 'control.permission_rule_added',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'permission_rule',
    resourceId: id,
    detail: { effect: input.effect, tool: input.tool, pattern: input.pattern },
  }).catch(() => undefined);
  return rowToRule(row);
}

export async function deletePermissionRule(userId: string, ruleId: string): Promise<boolean> {
  const deleted = await withTenant(userId, async (q) =>
    (await q.query('DELETE FROM user_permission_rules WHERE id = $1 AND user_id = $2', [ruleId, userId])).rowCount ?? 0,
  );
  await loadPermissionRules(userId);
  if (deleted) {
    await recordAudit({
      action: 'control.permission_rule_removed',
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'permission_rule',
      resourceId: ruleId,
      detail: {},
    }).catch(() => undefined);
  }
  return deleted > 0;
}
