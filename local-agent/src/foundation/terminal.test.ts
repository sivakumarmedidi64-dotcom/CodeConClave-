/**
 * CodeConClave Local Agent — terminal foundation tests.
 * Covers: session lifecycle (start → output → exit → status), exit codes,
 * stop/restart, failed starts. Uses the real PowerShell shell, which is
 * deterministic on piped stdin (prompt, line execution, exit codes).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalSession, type ProcessStatus } from '../terminal.js';

const SHELL = 'powershell';

let ws: string;

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), 'ccc-terminal-'));
});

afterAll(() => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(ws, { recursive: true, force: true });
      break;
    } catch {
      /* child processes may briefly hold the cwd; retry */
    }
  }
});

function waitForStatus(session: TerminalSession, wanted: ProcessStatus[], timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const { status } = session.getStatus();
      if (wanted.includes(status)) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${wanted.join('/')} (got ${status})`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

function waitForOutput(session: TerminalSession, needle: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const history = session.getHistory().join('');
      if (history.includes(needle)) return resolve(history);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for output containing ${needle}`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

describe('TerminalSession — lifecycle', () => {
  it('starts a real shell and reports RUNNING', async () => {
    const session = new TerminalSession('t1', SHELL, ws);
    try {
      const started = session.start();
      expect(started.ok).toBe(true);
      await waitForStatus(session, ['RUNNING']);
      expect(session.getStatus().status).toBe('RUNNING');
      await waitForOutput(session, 'PS C:');
    } finally {
      session.stop();
    }
  }, 30_000);

  it('streams stdout from the child process', async () => {
    const session = new TerminalSession('t2', SHELL, ws);
    try {
      session.start();
      session.write("Write-Output 'foundation-terminal-output-42'\n");
      await waitForOutput(session, 'foundation-terminal-output-42');
    } finally {
      session.stop();
    }
  }, 30_000);

  it('reports FAILED with the real exit code for non-zero exits', async () => {
    const session = new TerminalSession('t3', SHELL, ws);
    session.start();
    try {
      session.write('exit 3\n');
      await waitForStatus(session, ['FAILED', 'COMPLETED']);
      const { status, exitCode } = session.getStatus();
      expect(status).toBe('FAILED');
      expect(exitCode).toBe(3);
    } finally {
      session.stop();
    }
  }, 30_000);

  it('reports COMPLETED with exit code 0 for clean exits', async () => {
    const session = new TerminalSession('t4', SHELL, ws);
    session.start();
    try {
      session.write('exit 0\n');
      await waitForStatus(session, ['COMPLETED', 'FAILED']);
      const { status, exitCode } = session.getStatus();
      expect(status).toBe('COMPLETED');
      expect(exitCode).toBe(0);
    } finally {
      session.stop();
    }
  }, 30_000);

  it('refuses to start twice', async () => {
    const session = new TerminalSession('t5', SHELL, ws);
    session.start();
    try {
      expect(session.start().ok).toBe(false);
    } finally {
      session.stop();
    }
  }, 30_000);

  it('stop() transitions to KILLED and accepts further starts', async () => {
    const session = new TerminalSession('t6', SHELL, ws);
    session.start();
    session.stop();
    expect(session.getStatus().status).toBe('KILLED');
    const restarted = session.start();
    expect(restarted.ok).toBe(true);
    session.stop();
  }, 30_000);

  it('write() on a stopped session does not crash', async () => {
    const session = new TerminalSession('t7', SHELL, ws);
    expect(() => session.write('echo hi\n')).not.toThrow();
    session.stop();
  });

  it('marks the session FAILED when the process cannot start', async () => {
    const session = new TerminalSession('t8', SHELL, join(ws, 'does-not-exist'));
    const started = session.start();
    if (started.ok) {
      await waitForStatus(session, ['FAILED']);
      expect(session.getStatus().status).toBe('FAILED');
    }
  }, 30_000);

  it('emits status events to subscribers', async () => {
    const session = new TerminalSession('t9', SHELL, ws);
    const events: ProcessStatus[] = [];
    session.on('status', (_tab, status) => events.push(status));
    session.start();
    try {
      session.write('exit 0\n');
      await waitForStatus(session, ['COMPLETED', 'FAILED']);
      expect(events).toContain('RUNNING');
      expect(events).toContain('COMPLETED');
    } finally {
      session.stop();
    }
  }, 30_000);

  it('keeps bounded history', async () => {
    const session = new TerminalSession('t10', SHELL, ws);
    session.start();
    try {
      for (let i = 0; i < 25; i++) {
        session.write(`Write-Output 'line-${i}'\n`);
      }
      await waitForOutput(session, 'line-24');
    } finally {
      session.stop();
    }
    expect(session.getHistory().length).toBeLessThanOrEqual(1000);
  }, 30_000);
});

describe('TerminalSession — Phase 4B state machine', () => {
  it('starts PLANNED with no pid and only RUNNING carries real pid evidence', async () => {
    const session = new TerminalSession('t11', SHELL, ws);
    expect(session.getStatus().status).toBe('PLANNED');
    expect(session.getStatus().pid).toBeNull();
    session.start();
    try {
      await waitForStatus(session, ['RUNNING']);
      const { status, pid } = session.getStatus();
      expect(status).toBe('RUNNING');
      expect(pid).toBeGreaterThan(0);
    } finally {
      session.stop();
    }
  }, 30_000);

  it('transitions to TIMED_OUT when timeoutMs elapses on a live process', async () => {
    const session = new TerminalSession('t12', 'node', ws, { timeoutMs: 300 });
    session.start();
    try {
      await waitForStatus(session, ['TIMED_OUT'], 10_000);
      expect(session.getStatus().status).toBe('TIMED_OUT');
    } finally {
      session.stop();
    }
  }, 30_000);

  it('stop() on a running session reports KILLED and allows restart', async () => {
    const session = new TerminalSession('t13', SHELL, ws);
    session.start();
    await waitForStatus(session, ['RUNNING']);
    session.stop();
    expect(session.getStatus().status).toBe('KILLED');
    const restarted = session.start();
    expect(restarted.ok).toBe(true);
    await waitForStatus(session, ['RUNNING']);
    session.stop();
  }, 30_000);

  it('emits STARTING before RUNNING through the status event', async () => {
    const session = new TerminalSession('t14', SHELL, ws);
    const events: ProcessStatus[] = [];
    session.on('status', (_tab, status) => events.push(status));
    session.start();
    try {
      await waitForStatus(session, ['RUNNING']);
      expect(events).toContain('STARTING');
      expect(events).toContain('RUNNING');
    } finally {
      session.stop();
    }
  }, 30_000);
});