/**
 * CodeConClave — serve-scope regression suite.
 *
 * Pins the real defect found by the first live wire run: the `serve`
 * file.read/file.diff/file.write handlers denied EVERY nested path with
 * "capability not granted" because the check compared the workspace ROOT
 * against the resolved FILE path. Capability checks must run against the
 * matched grant. Uses a real temp dir (realpath behavior included).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '../config.js';
import { workspaceFor, requestedWithin, grantHasCap } from '../serve-scope.js';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-serve-scope-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.txt'), 'x\n', 'utf8');
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function config(caps: string[]): AgentConfig {
  return {
    version: '0.1.0',
    deviceId: 'd',
    deviceSecretHash: 'x',
    createdAt: new Date().toISOString(),
    workspaces: [{ root, name: 'ws', capabilities: caps }],
  };
}

describe('serve-scope — grant-carrying resolution', () => {
  it('resolves a nested file and carries the matched grant', () => {
    const file = join(root, 'src', 'app.txt');
    const scope = workspaceFor(config(['file_read', 'file_write']), file);
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(scope.abs).toBe(file);
    expect(scope.grant.root).toBe(root);
    expect(scope.grant.capabilities).toContain('file_read');
    // Handlers re-resolve (abs, within): for an already-resolved path the
    // remainder is '.', which round-trips to the same file.
    expect(requestedWithin(scope, file)).toBe('.');
  });

  it('grants file_read for a nested file when the workspace allows it (the live-wire regression)', () => {
    const scope = workspaceFor(config(['file_read', 'file_write']), join(root, 'src', 'app.txt'));
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(grantHasCap(scope.grant, 'file_read')).toBe(true);
    expect(grantHasCap(scope.grant, 'file_write')).toBe(true);
    expect(grantHasCap(scope.grant, 'terminal_exec')).toBe(false);
  });

  it('denies a capability the grant does not carry', () => {
    const scope = workspaceFor(config(['file_read']), join(root, 'src', 'app.txt'));
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    expect(grantHasCap(scope.grant, 'file_write')).toBe(false);
  });

  it('denies paths outside every grant', () => {
    const scope = workspaceFor(config(['file_read', 'file_write']), join(root, '..', 'outside.txt'));
    expect(scope.ok).toBe(false);
  });

  it('grantHasCap is false without a grant', () => {
    expect(grantHasCap(undefined, 'file_read')).toBe(false);
  });
});
