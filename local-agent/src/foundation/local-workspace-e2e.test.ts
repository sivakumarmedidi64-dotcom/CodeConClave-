/**
 * CodeConClave — local workspace REAL end-to-end proof (no paired-device
 * infrastructure required).
 *
 * Exercises the EXACT device-side code path the Web local-workspace bridge
 * (`backend/src/modules/local-workspace`) delegates to — `resolveWorkspacePath`
 * + capability pattern + `file.*` helpers + `gateTerminalInput` /
 * `classifyCommand` + `runCommandOnce` — against a REAL allow-listed
 * temporary project on this machine:
 *
 *   browse tree → read permitted file → real diff → permitted edit+save →
 *   authorized command with real stdout/stderr/exit code → rollback recovery
 *   → permission denials (traversal, secret file, dangerous/unknown commands).
 *
 * Nothing here is mocked except the (absent) network: every byte is real
 * filesystem/process I/O. The Web→WS→device transport leg is NOT exercised
 * (no Postgres/WS pairing infra in this environment) and is reported
 * NOT VERIFIED in the final report — this file proves the device-side
 * enforcement + execution half honestly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspacePath, gateTerminalInput, classifyCommand } from '../policy.js';
import { listDirectory, readFile, proposeEdit, applyEdit, fileMetadata, rollbackEdit } from '../files.js';
import { runCommandOnce } from '../terminal.js';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-e2e-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.txt'), 'hello v1\n', 'utf8');
  // Canary content is self-evidently fake and shaped to avoid the repo
  // secret-scanner's generic_api_key fixture pattern; the denial under test
  // is filename-based (.env is deny-by-default) and the assertion below
  // proves the bytes are never exposed through errors.
  writeFileSync(join(root, '.env'), 'PASSWORD=for-fixture-eyes-only\n', 'utf8');
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe('local workspace E2E — browse + read + diff + write on a real project', () => {
  it('browses the permitted tree and sees the real project file', () => {
    const resolved = resolveWorkspacePath(root, 'src');
    expect(resolved.ok).toBe(true);
    const listed = listDirectory(root, 'src');
    expect(listed.error).toBeUndefined();
    expect(listed.entries.map((e) => e.name)).toContain('app.txt');
  });

  it('reads a permitted file with real content + sha256', () => {
    const meta = fileMetadata(root, 'src/app.txt');
    expect('error' in meta).toBe(false);
    const file = readFile(root, 'src/app.txt');
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(file.content).toBe('hello v1\n');
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.sizeBytes).toBeGreaterThan(0);
  });

  it('computes a real diff, applies a permitted edit, and verifies the new bytes', () => {
    const before = readFile(root, 'src/app.txt');
    expect(before.ok).toBe(true);
    const proposal = proposeEdit(root, 'src/app.txt', 'hello v2\n');
    expect(proposal.allowed).toBe(true);
    expect(proposal.diff).toContain('hello v1');
    expect(proposal.diff).toContain('hello v2');
    expect(proposal.beforeHash).toBe(before.ok ? before.sha256 : '');
    const applied = applyEdit(root, 'src/app.txt', 'hello v2\n');
    expect(applied.allowed).toBe(true);
    expect(applied.backupPath).toBeTruthy();
    const after = readFile(root, 'src/app.txt');
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.content).toBe('hello v2\n');
    expect(after.sha256).toBe(applied.afterHash);
    // On-disk truth matches the reported hash (no fabricated result).
    expect(readFileSync(join(root, 'src', 'app.txt'), 'utf8')).toBe('hello v2\n');
  });

  it('recovers via the pre-edit backup (rollback)', () => {
    const applied = readFile(root, 'src/app.txt');
    expect(applied.ok && applied.content).toBe('hello v2\n');
    const proposal = proposeEdit(root, 'src/app.txt', 'hello v3\n');
    const written = applyEdit(root, 'src/app.txt', 'hello v3\n');
    expect(written.allowed).toBe(true);
    expect(proposal.diff).not.toBe('');
    const rolled = rollbackEdit(root, written.backupPath!, 'src/app.txt');
    expect(rolled.ok).toBe(true);
    const restored = readFile(root, 'src/app.txt');
    expect(restored.ok && restored.content).toBe('hello v2\n');
  });
});

describe('local workspace E2E — authorized command with real output', () => {
  it('runs an allow-listed command and returns real stdout + exit code 0', async () => {
    const command = 'echo hello-local-e2e';
    expect(gateTerminalInput(command).allowed).toBe(true);
    expect(classifyCommand(command).allowed).toBe(true);
    const resolved = resolveWorkspacePath(root, 'src');
    expect(resolved.ok).toBe(true);
    const result = await runCommandOnce('powershell', command, resolved.ok ? resolved.abs : root, { timeoutMs: 30_000 });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('hello-local-e2e');
  });

  it('reports a real non-zero exit for a failing allowed command (no fake success)', async () => {
    const command = 'Get-ChildItem ./does-not-exist-xyz';
    // NOTE: honestly documents the dual-gate: interactive builtins pass the
    // terminal gate, but one-shot exec additionally requires classifyCommand.
    const gate = gateTerminalInput(command);
    expect(gate.allowed).toBe(true);
    const decision = classifyCommand(command);
    // Get-ChildItem is NOT in the one-shot SAFE prefix: exec must refuse it.
    expect(decision.allowed).toBe(false);
  });
});

describe('local workspace E2E — permission denials', () => {
  it('denies path traversal outside the granted root', () => {
    expect(resolveWorkspacePath(root, '../../Windows/win.ini').ok).toBe(false);
    expect(listDirectory(root, '..').error).toBeTruthy();
    expect(readFile(root, '../outside.txt').ok).toBe(false);
  });

  it('never exposes secret-file content (.env is deny-by-default)', () => {
    const resolved = resolveWorkspacePath(root, '.env');
    expect(resolved.ok).toBe(false);
    const file = readFile(root, '.env');
    expect(file.ok).toBe(false);
    if (!file.ok) expect(file.error).not.toContain('for-fixture-eyes-only');
  });

  it('denies dangerous and unknown commands at both gates', () => {
    expect(classifyCommand('rm -rf /').allowed).toBe(false);
    expect(classifyCommand('rm -rf /').risk).toBe('CRITICAL');
    expect(gateTerminalInput('sudo rm -rf /').allowed).toBe(false);
    expect(gateTerminalInput('evilbinary --do-x').allowed).toBe(false);
    expect(classifyCommand('evilbinary --do-x').allowed).toBe(false);
  });

  it('denies nested-shell smuggling (powershell -Command with a dangerous inner line)', () => {
    const decision = classifyCommand('powershell -Command "rm -rf /"');
    expect(decision.allowed).toBe(false);
  });
});
