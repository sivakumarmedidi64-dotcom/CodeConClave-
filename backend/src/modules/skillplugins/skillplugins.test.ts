import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, builtinPlugin } from './catalog.js';
import { MAX_INJECTED_SKILL_CHARS, manifestSchema, type PluginManifest } from './manifest.js';
import { buildSkillBlock, expandSlashCommand, listCommands } from './service.js';

const reviewer = builtinPlugin('reviewer')!;
const docs = builtinPlugin('docs')!;

describe('built-in catalog', () => {
  it('every built-in manifest validates and slugs are unique', () => {
    const slugs = BUILTIN_PLUGINS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const p of BUILTIN_PLUGINS) expect(manifestSchema.safeParse(p).success).toBe(true);
  });

  it('covers every specialised coworker from the spec', () => {
    for (const slug of ['architect', 'coder', 'security', 'tester', 'performance', 'research', 'docs', 'reviewer', 'planner']) {
      expect(builtinPlugin(slug), slug).not.toBeNull();
    }
  });
});

describe('manifest validation', () => {
  const base = {
    slug: 'my-plugin',
    name: 'Mine',
    version: '1.0.0',
    description: 'A custom plugin for tests',
    author: 'me',
    category: 'productivity',
    icon: 'puzzle',
    commands: [{ name: 'hello', description: 'say hi', prompt: 'Say hello to $ARGUMENTS politely.' }],
  };

  it('accepts a minimal valid manifest', () => {
    expect(manifestSchema.safeParse(base).success).toBe(true);
  });

  it('rejects a plugin with no skills and no commands', () => {
    expect(manifestSchema.safeParse({ ...base, commands: [] }).success).toBe(false);
  });

  it('rejects bad slugs, versions and command names', () => {
    expect(manifestSchema.safeParse({ ...base, slug: 'Bad Slug' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, version: 'v1' }).success).toBe(false);
    expect(
      manifestSchema.safeParse({ ...base, commands: [{ ...base.commands[0], name: '/hello' }] }).success,
    ).toBe(false);
  });

  it('carries no executable fields (unknown keys are stripped)', () => {
    const parsed = manifestSchema.parse({ ...base, hooks: [{ run: 'rm -rf /' }], script: 'x' }) as Record<string, unknown>;
    expect(parsed.hooks).toBeUndefined();
    expect(parsed.script).toBeUndefined();
  });
});

describe('slash commands', () => {
  it('expands an enabled command with its arguments', () => {
    const r = expandSlashCommand('/review fix the null check in auth.ts', [reviewer]);
    expect(r?.plugin).toBe('reviewer');
    expect(r?.expanded).toContain('fix the null check in auth.ts');
    expect(r?.expanded).not.toContain('$ARGUMENTS');
  });

  it('asks for details when no arguments are given', () => {
    expect(expandSlashCommand('/review', [reviewer])?.expanded).toContain('no details given');
  });

  it('leaves unknown commands, disabled plugins and paths untouched', () => {
    expect(expandSlashCommand('/review x', [])).toBeNull();
    expect(expandSlashCommand('/nope x', [reviewer])).toBeNull();
    expect(expandSlashCommand('/usr/local/bin is on PATH', [reviewer])).toBeNull();
    expect(expandSlashCommand('please /review this', [reviewer])).toBeNull();
  });

  it('lists commands with their plugin, first plugin wins a name clash', () => {
    const clash: PluginManifest = { ...docs, slug: 'zz-clash', name: 'Clash', commands: [{ ...reviewer.commands[0]! }] };
    const cmds = listCommands([reviewer, docs, clash]);
    expect(cmds.filter((c) => c.name === 'review')).toHaveLength(1);
    expect(cmds.find((c) => c.name === 'review')?.plugin).toBe('reviewer');
    expect(cmds.find((c) => c.name === 'readme')?.icon).toBe(docs.icon);
  });
});

describe('skill block', () => {
  it('is empty with no plugins and labelled when present', () => {
    expect(buildSkillBlock([])).toBe('');
    const block = buildSkillBlock([reviewer]);
    expect(block).toContain('never override the rules above');
    expect(block).toContain('Reviewer › Review for correctness first');
  });

  it('is capped so plugins cannot flood the system prompt', () => {
    const big: PluginManifest = {
      ...reviewer,
      skills: Array.from({ length: 8 }, (_, i) => ({ name: `s${i}`, description: 'big skill', instructions: 'x'.repeat(3900) })),
    };
    expect(buildSkillBlock([big, big]).length).toBeLessThan(MAX_INJECTED_SKILL_CHARS + 400);
  });
});

describe('Safe Workflow plugin (constitution Article 7)', () => {
  const safe = builtinPlugin('safe-workflow')!;

  it('ships /feature, /bugfix, /second-review and /guard', () => {
    expect(safe.commands.map((c) => c.name)).toEqual(['feature', 'bugfix', 'second-review', 'guard']);
  });

  it('/second-review expands into a review that never edits files', () => {
    const r = expandSlashCommand('/second-review the auth change in login.ts', [safe]);
    expect(r?.expanded).toContain('Do NOT change any files: the auth change in login.ts');
    expect(r?.expanded).toContain('never invent findings');
  });

  it('/bugfix starts read-only and asks for a failing regression test', () => {
    const r = expandSlashCommand('/bugfix login loops after token expiry', [safe]);
    expect(r?.expanded).toContain('Start read-only');
    expect(r?.expanded).toContain('regression test that fails before the fix');
  });

  it('no command name clashes with another built-in plugin', () => {
    const names = BUILTIN_PLUGINS.flatMap((p) => p.commands.map((c) => c.name));
    expect(new Set(names).size).toBe(names.length);
  });
});
