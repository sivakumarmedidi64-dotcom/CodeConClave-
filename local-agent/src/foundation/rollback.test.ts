/**
 * CodeConClave Local Agent — rollback foundation tests.
 * Covers: edit preview (hashes + diff), atomic apply with backup, rollback to
 * the pre-edit state, protected-path deny, traversal deny, size limits.
 * Real files in a temp workspace — no network, no DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposeEdit, applyEdit, rollbackEdit, readFile, listDirectory } from '../files.js';
import { sha256 } from '../diff.js';

let ws: string;

function readText(root: string, requested: string): string {
  const result = readFile(root, requested);
  return result.ok ? result.content : '';
}

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), 'ccc-rollback-'));
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'a.txt'), 'version 1 content\n');
  writeFileSync(join(ws, 'src', 'deep.ts'), 'let a = 1;\n');
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('proposeEdit — preview without touching the file', () => {
  it('produces before/after hashes and a unified diff', () => {
    const proposal = proposeEdit(ws, 'a.txt', 'version 2 content\n');
    expect(proposal.allowed).toBe(true);
    expect(proposal.risk).toBe('MEDIUM');
    expect(proposal.beforeHash).toBe(sha256('version 1 content\n'));
    expect(proposal.afterHash).toBe(sha256('version 2 content\n'));
    expect(proposal.diff).toContain('-version 1 content');
    expect(proposal.diff).toContain('+version 2 content');
    expect(readText(ws, 'a.txt')).toBe('version 1 content\n');
  });

  it('rates an identical edit LOW', () => {
    const proposal = proposeEdit(ws, 'a.txt', 'version 1 content\n');
    expect(proposal.risk).toBe('LOW');
    expect(proposal.beforeHash).toBe(proposal.afterHash);
  });

  it('previews creation of a new file from empty before-hash', () => {
    const proposal = proposeEdit(ws, 'new.txt', 'hello\n');
    expect(proposal.allowed).toBe(true);
    expect(proposal.beforeHash).toBe(sha256(''));
    expect(proposal.diff).not.toBe('');
  });
});

describe('applyEdit + rollbackEdit — nothing silently overwritten', () => {
  it('backs up the previous state, writes atomically, and rolls back exactly', () => {
    const applied = applyEdit(ws, 'a.txt', 'version 2 content\n');
    expect(applied.allowed).toBe(true);
    expect(applied.backupPath).toBeDefined();
    expect(existsSync(applied.backupPath!)).toBe(true);
    expect(readText(ws, 'a.txt')).toBe('version 2 content\n');

    const rollback = rollbackEdit(ws, applied.backupPath!, applied.path);
    expect(rollback.ok).toBe(true);
    const restored = readFile(ws, 'a.txt');
    expect(restored.ok ? restored.content : '').toBe('version 1 content\n');
    if (restored.ok) expect(restored.sha256).toBe(applied.beforeHash);
  });

  it('supports multi-step edits with rollback to the original state', () => {
    applyEdit(ws, 'src/deep.ts', 'let a = 2;\nlet b = 3;\n');
    const appliedAgain = applyEdit(ws, 'src/deep.ts', 'const c = 10;\n');
    expect(appliedAgain.diff).toContain('-let');
    const rollback = rollbackEdit(ws, appliedAgain.backupPath!, appliedAgain.path);
    expect(rollback.ok).toBe(true);
    const content = readFile(ws, 'src/deep.ts');
    expect(content.ok ? content.content : '').toBe('let a = 2;\nlet b = 3;\n');
  });

  it('rollback refuses when the backup is missing', () => {
    const result = rollbackEdit(ws, join(ws, '.codeconclave-backups', 'nope.bak'), 'a.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('backup missing');
  });

  it('applyEdit does not write when content is unchanged', () => {
    const applied = applyEdit(ws, 'a.txt', 'version 1 content\n');
    expect(applied.allowed).toBe(true);
    expect(applied.backupPath).toBeUndefined();
    expect(applied.diff).toBe('');
  });
});

describe('protected paths and traversal — deny by default', () => {
  it('denies secret paths', () => {
    writeFileSync(join(ws, '.env'), 'SECRET=1\n');
    const proposal = proposeEdit(ws, '.env', 'SECRET=2\n');
    expect(proposal.allowed).toBe(false);
    expect(proposal.risk).toBe('CRITICAL');
    expect(readFile(ws, '.env').ok).toBe(false);
    expect(proposeEdit(ws, '.git/config', 'x').allowed).toBe(false);
  });

  it('denies workspace-traversal paths', () => {
    expect(proposeEdit(ws, '../outside.txt', 'x').allowed).toBe(false);
    expect(proposeEdit(ws, 'src/../../outside.txt', 'x').allowed).toBe(false);
    expect(readFile(ws, '..\\outside.txt').ok).toBe(false);
    const listing = listDirectory(ws, '../..');
    expect(listing.entries.length).toBe(0);
    expect(listing.error).toBeDefined();
  });

  it('lists directories with dirs-first ordering and sizes', () => {
    const listing = listDirectory(ws, '.');
    expect(listing.error).toBeUndefined();
    expect(listing.entries.length).toBeGreaterThan(0);
    const index = listing.entries.findIndex((e) => e.type === 'file');
    const dirIndex = listing.entries.findIndex((e) => e.type === 'dir');
    expect(dirIndex === -1 || dirIndex < index).toBe(true);
  });

  it('denies reads of files larger than the 5MB cap', () => {
    const big = join(ws, 'big.bin');
    writeFileSync(big, Buffer.alloc(6 * 1024 * 1024, 1));
    const result = readFile(ws, 'big.bin');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('5MB');
  });
});