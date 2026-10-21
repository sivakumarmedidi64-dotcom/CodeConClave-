/**
 * Article 1 (permission rules) and Article 3 (no live credentials written by
 * agents): deterministic policy tests, no database.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateToolCall, registerGrants, credentialFindings } from '../execution/policy.js';
import { _setPermissionModeForTests } from './permissionMode.js';
import { _setRulesForTest, globToRegExp, ruleSubject, strongestRule, validateRuleInput, type PermissionRule } from './permissionRules.js';

const rule = (effect: PermissionRule['effect'], tool: PermissionRule['tool'], pattern: string, id = `r_${effect}_${pattern}`): PermissionRule => ({
  id,
  effect,
  tool,
  pattern,
  note: null,
  createdAt: new Date().toISOString(),
});

const U = 'u_rules';
beforeEach(() => {
  registerGrants([
    { id: 'gw', userId: U, capability: 'WRITE_WORKSPACE', scope: '*', expiresAt: Date.now() + 600_000 },
    { id: 'gr', userId: U, capability: 'READ_WORKSPACE', scope: '*', expiresAt: Date.now() + 600_000 },
    { id: 'gx', userId: U, capability: 'EXECUTE_COMMAND', scope: '*', expiresAt: Date.now() + 600_000 },
  ]);
  _setPermissionModeForTests(U, 'ask');
  _setRulesForTest(U, []);
});

describe('permission rules — matching', () => {
  it('globs: * spans folders, ? is one character, case-insensitive', () => {
    expect(globToRegExp('src/*').test('src/app/index.ts')).toBe(true);
    expect(globToRegExp('*.md').test('docs/README.md')).toBe(true);
    expect(globToRegExp('npm run test*').test('npm run test:unit')).toBe(true);
    expect(globToRegExp('file?.txt').test('file1.txt')).toBe(true);
    expect(globToRegExp('file?.txt').test('file12.txt')).toBe(false);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });

  it('compares paths with forward slashes and commands with collapsed spaces', () => {
    expect(ruleSubject('file_write', { path: 'src\\app\\x.ts' })).toBe('src/app/x.ts');
    expect(ruleSubject('terminal_exec', { command: '  npm   test ' })).toBe('npm test');
    expect(ruleSubject('browser_open', { url: 'https://docs.example.com/a' })).toBe('https://docs.example.com/a');
  });

  it('deny beats ask beats allow', () => {
    const rules = [rule('allow', 'file_write', 'src/*'), rule('ask', '*', 'src/payments/*'), rule('deny', 'file_write', 'src/payments/keys.ts')];
    expect(strongestRule(rules, 'file_write', { path: 'src/ui/a.ts' })?.effect).toBe('allow');
    expect(strongestRule(rules, 'file_write', { path: 'src/payments/a.ts' })?.effect).toBe('ask');
    expect(strongestRule(rules, 'file_write', { path: 'src/payments/keys.ts' })?.effect).toBe('deny');
    expect(strongestRule(rules, 'terminal_exec', { command: 'ls' })).toBeNull();
  });
});

describe('permission rules — in the policy engine', () => {
  it('allow skips the prompt for a matching MEDIUM write', () => {
    expect(evaluateToolCall({ tool: 'file_write', input: { path: 'docs/a.md', content: 'hi' }, userId: U })).toMatchObject({ allowed: true, requiresApproval: true });
    _setRulesForTest(U, [rule('allow', 'file_write', 'docs/*')]);
    expect(evaluateToolCall({ tool: 'file_write', input: { path: 'docs/a.md', content: 'hi' }, userId: U })).toMatchObject({
      allowed: true,
      requiresApproval: false,
      approvalWaivedBy: 'user_rule',
    });
  });

  it('allow never waives a delete or a HIGH-risk action', () => {
    _setRulesForTest(U, [rule('allow', '*', 'src/*')]);
    const del = evaluateToolCall({ tool: 'file_delete', input: { path: 'src/a.ts' }, userId: U });
    expect(del).toMatchObject({ allowed: true, requiresApproval: true });
  });

  it('allow never skips the prompt for a connector action (emails, posts, publishing always ask)', () => {
    _setRulesForTest(U, [rule('allow', 'plugin_action', '*')]);
    const send = evaluateToolCall({ tool: 'plugin_action', input: { pluginType: 'gmail', action: 'send_email' }, userId: U });
    expect(send).toMatchObject({ allowed: true, requiresApproval: true });
  });

  it('ask forces approval even in Auto-accept mode', () => {
    _setPermissionModeForTests(U, 'accept_edits');
    expect(evaluateToolCall({ tool: 'file_write', input: { path: 'src/payments/a.ts', content: 'x' }, userId: U })).toMatchObject({ requiresApproval: false });
    _setRulesForTest(U, [rule('ask', 'file_write', 'src/payments/*')]);
    expect(evaluateToolCall({ tool: 'file_write', input: { path: 'src/payments/a.ts', content: 'x' }, userId: U })).toMatchObject({
      allowed: true,
      requiresApproval: true,
      approvalForcedBy: 'user_rule',
    });
  });

  it('deny blocks a command the baseline would allow', () => {
    _setRulesForTest(U, [rule('deny', 'terminal_exec', 'npm publish*')]);
    const d = evaluateToolCall({ tool: 'terminal_exec', input: { command: 'npm publish --access public' }, userId: U });
    expect(d).toMatchObject({ allowed: false, deniedBy: 'user_rule' });
  });

  it('no rule can unblock the baseline (secret paths, dangerous commands)', () => {
    _setRulesForTest(U, [rule('allow', '*', '.env'), rule('allow', 'terminal_exec', 'rm -rf /')]);
    expect(evaluateToolCall({ tool: 'file_write', input: { path: '.env', content: 'A=1' }, userId: U })).toMatchObject({ allowed: false, deniedBy: 'baseline_secrets' });
    expect(evaluateToolCall({ tool: 'terminal_exec', input: { command: 'rm -rf /' }, userId: U })).toMatchObject({ allowed: false, deniedBy: 'baseline_commands' });
  });

  it('refuses rules that are malformed or switch everything off', () => {
    expect(() => validateRuleInput({ effect: 'maybe', tool: 'file_write', pattern: 'x' })).toThrow(/allow, ask or deny/);
    expect(() => validateRuleInput({ effect: 'allow', tool: 'rm', pattern: 'x' })).toThrow(/tool must be/);
    expect(() => validateRuleInput({ effect: 'allow', tool: '*', pattern: '*' })).toThrow(/too broad/);
    expect(validateRuleInput({ effect: 'deny', tool: '*', pattern: '*', note: ' lock down ' })).toEqual({ effect: 'deny', tool: '*', pattern: '*', note: 'lock down' });
  });
});

describe('no live credentials written by agents (Article 3)', () => {
  const ghToken = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  it('blocks a file write that contains a live token', () => {
    const d = evaluateToolCall({ tool: 'file_write', input: { path: 'src/config.ts', content: `export const token = '${ghToken}';` }, userId: U });
    expect(d).toMatchObject({ allowed: false, deniedBy: 'baseline_secret_content' });
    expect((d as { reason: string }).reason).toMatch(/GitHub personal access token/);
    expect((d as { reason: string }).reason).not.toContain(ghToken);
  });

  it('blocks it on the paired laptop too, and an allow rule cannot override it', () => {
    _setRulesForTest(U, [rule('allow', 'local_write', '*')]);
    const d = evaluateToolCall({ tool: 'local_write', input: { deviceId: 'dev1', path: 'notes.txt', content: '-----BEGIN RSA PRIVATE KEY-----' }, userId: U });
    expect(d).toMatchObject({ allowed: false, deniedBy: 'baseline_secret_content' });
  });

  it('keeps placeholders, docs and local dev URLs working', () => {
    expect(credentialFindings('API_KEY=your-api-key-here')).toEqual([]);
    expect(credentialFindings('DATABASE_URL=postgres://postgres:postgres@localhost:5432/app')).toEqual([]);
    expect(credentialFindings('DATABASE_URL=postgres://user:${DB_PASSWORD}@prod.example.com/app')).toEqual([]);
    expect(credentialFindings('DATABASE_URL=postgres://app:S3cr3tPass99@db.prod.example.com:5432/app').map((f) => f.kind)).toEqual(['connection_string']);
    expect(evaluateToolCall({ tool: 'file_write', input: { path: 'README.md', content: 'Set OPENAI_API_KEY in your env.' }, userId: U })).toMatchObject({ allowed: true });
  });
});
