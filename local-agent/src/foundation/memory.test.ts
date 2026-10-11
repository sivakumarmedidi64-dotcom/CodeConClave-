/**
 * CodeConClave — local memory folder tests (real temp workspace).
 *
 * Pins: auto-creation of memory/ on first activity, JSONL activity
 * entries with hashes/outcomes but NEVER file content or command output,
 * chat transcript sync as readable markdown (idempotent per conversation),
 * strict validation of hostile sync payloads, and proof the memory folder
 * itself is NOT caught by the secret-path deny list.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordLocalActivity, syncChatTranscript, memoryDirFor, MEMORY_DIR_NAME } from '../memory.js';
import { isProtectedPath, resolveWorkspacePath } from '../policy.js';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-memory-'));
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('local memory folder', () => {
  it('is not treated as a secret/protected path', () => {
    expect(isProtectedPath(join(root, MEMORY_DIR_NAME, 'activity', '2026-01-01.jsonl'))).toBe(false);
    expect(isProtectedPath(join(root, MEMORY_DIR_NAME, 'chats', 'abc.md'))).toBe(false);
    // The memory dir itself resolves inside the workspace once created.
    mkdirSync(join(root, MEMORY_DIR_NAME, 'activity'), { recursive: true });
    expect(resolveWorkspacePath(root, join(MEMORY_DIR_NAME, 'activity')).ok).toBe(true);
  });

  it('auto-creates on first activity and stores hashes, never content', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'cc-memory-fresh-'));
    try {
      expect(existsSync(memoryDirFor(fresh))).toBe(false);
      const created = recordLocalActivity(fresh, {
        kind: 'command',
        command: 'npm test',
        exitCode: 0,
        timedOut: false,
        outputBytes: 10,
      });
      expect(created).toBeTruthy();
      expect(existsSync(memoryDirFor(fresh))).toBe(true);
    } finally {
      try {
        rmSync(fresh, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    const file = recordLocalActivity(root, {
      kind: 'file_write',
      path: join(root, 'src', 'a.ts'),
      beforeHash: 'b'.repeat(64),
      afterHash: 'a'.repeat(64),
    });
    expect(file).toBeTruthy();
    expect(existsSync(memoryDirFor(root))).toBe(true);
    const line = readFileSync(file!, 'utf8');
    expect(line).toContain('file_write');
    expect(line).toContain('a'.repeat(64));
  });

  it('records command outcomes without output text', () => {
    const file = recordLocalActivity(root, {
      kind: 'command',
      command: 'npm test',
      exitCode: 0,
      timedOut: false,
      outputBytes: 44,
    });
    const lines = readFileSync(file!, 'utf8').split('\n').filter(Boolean);
    const entry = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    // The command line is the audit fact; output BYTES are counted but output
    // TEXT is never stored (it may echo secrets).
    expect(entry.command).toBe('npm test');
    expect(entry.outputBytes).toBe(44);
    expect('output' in entry).toBe(false);
    expect('content' in entry).toBe(false);
  });

  it('syncs a chat transcript to readable markdown, idempotently', () => {
    const first = syncChatTranscript(root, {
      conversationId: 'conv_1',
      turns: [
        { role: 'user', content: 'Fix the login bug' },
        { role: 'assistant', content: 'Fixed in auth.ts' },
      ],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.turns).toBe(2);
    const md = readFileSync(first.path, 'utf8');
    expect(md).toContain('# Chat conv_1');
    expect(md).toContain('## user');
    expect(md).toContain('Fix the login bug');
    const second = syncChatTranscript(root, {
      conversationId: 'conv_1',
      turns: [{ role: 'user', content: 'Thanks' }],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.path).toBe(first.path);
    expect(readFileSync(second.path, 'utf8')).toContain('Thanks');
    expect(readFileSync(second.path, 'utf8')).not.toContain('login bug');
  });

  it('rejects hostile sync payloads without writing', () => {
    expect(syncChatTranscript(root, { conversationId: '../../evil', turns: [{ role: 'user', content: 'x' }] }).ok).toBe(false);
    expect(syncChatTranscript(root, { conversationId: 'c', turns: [] }).ok).toBe(false);
    expect(syncChatTranscript(root, { conversationId: 'c', turns: [{ role: 'hacker', content: 'x' }] }).ok).toBe(false);
    expect(syncChatTranscript(root, { conversationId: 'c', turns: Array.from({ length: 201 }, () => ({ role: 'user', content: 'x' })) }).ok).toBe(false);
    expect(syncChatTranscript(root, { conversationId: 'c', turns: [{ role: 'user', content: 'x'.repeat(8001) }] }).ok).toBe(false);
    expect(readdirSync(join(memoryDirFor(root), 'chats')).sort()).toEqual(['conv_1.md']);
  });
});
