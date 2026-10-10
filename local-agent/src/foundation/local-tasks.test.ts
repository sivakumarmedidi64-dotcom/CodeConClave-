/**
 * CodeConClave Local Agent — P0 local task executor tests.
 *
 * Proves the execution boundary is honest:
 *  - no instruction → task FAILED with `no_local_instruction` (never fabricated);
 *  - policy-denied commands are refused before any execution;
 *  - a granted command reports the REAL result and REAL artifact refs;
 *  - a failing command reports `local_command_failed`, not PASS.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runCommandOnce = vi.hoisted(() => vi.fn());
vi.mock('../terminal.js', () => ({ runCommandOnce, TerminalSession: class { } }));

import { createLocalTaskExecutor, type LocalTaskExecutor } from '../tasks.js';
import type { AgentConfig } from '../config.js';

function makeConfig(root: string): AgentConfig {
  return {
    version: '0.1.0',
    deviceId: 'dev_1',
    deviceSecretHash: 'x',
    createdAt: new Date().toISOString(),
    pairedTo: 'http://localhost:4000',
    token: 'tok',
    workspaces: [{ root, name: 'ws', capabilities: ['file_read', 'file_write', 'terminal_exec', 'git_op'] }],
  };
}

function frame(task: Record<string, unknown>): Record<string, unknown> {
  return { assignmentId: 'lta_1', leaseExpiresAt: new Date().toISOString(), task: { id: 'tsk_1', ...task } };
}

interface Harness {
  sent: Record<string, unknown>[];
  executor: LocalTaskExecutor;
  waitFor: (pred: (m: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  settle: () => Promise<void>;
}

function harness(config: AgentConfig): Harness {
  const sent: Record<string, unknown>[] = [];
  const executor = createLocalTaskExecutor((m) => sent.push(m));
  const waitFor = (pred: (m: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const found = sent.find(pred);
        if (found) return resolve(found);
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for frame'));
        setTimeout(tick, 5);
      };
      tick();
    });
  const settle = () => waitFor((m) => m.type === 'task_fail' || m.type === 'task_complete').then(() => executor.ack({ ok: true, assignmentId: 'lta_1' }));
  return { sent, executor, waitFor, settle };
}

describe('P0 local task executor', () => {
  beforeEach(() => {
    runCommandOnce.mockReset();
  });

  it('fails honestly when the task carries no executable instruction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-lp-'));
    const h = harness(makeConfig(root));
    h.executor.handle(frame({ title: 'Run on my machine', requiredCapabilities: ['terminal_exec'] }), makeConfig(root));
    await h.waitFor((m) => m.type === 'task_claim');
    h.executor.ack({ ok: true, assignmentId: 'lta_1', attemptNumber: 1 });
    const fail = await h.waitFor((m) => m.type === 'task_fail');
    expect(fail.errorCode).toBe('no_local_instruction');
    await h.settle();
    expect(runCommandOnce).not.toHaveBeenCalled();
  });

  it('refuses a policy-denied command without executing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-lp-'));
    const h = harness(makeConfig(root));
    h.executor.handle(frame({ instruction: { command: 'rm -rf /' } }), makeConfig(root));
    await h.waitFor((m) => m.type === 'task_claim');
    h.executor.ack({ ok: true, assignmentId: 'lta_1', attemptNumber: 1 });
    const fail = await h.waitFor((m) => m.type === 'task_fail');
    expect(fail.errorCode).toBe('policy_denied');
    await h.settle();
    expect(runCommandOnce).not.toHaveBeenCalled();
  });

  it('reports a real success and real artifact references', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-lp-'));
    writeFileSync(join(root, 'out.md'), 'result-content');
    runCommandOnce.mockResolvedValue({ ok: true, output: 'built ok\n', exitCode: 0, timedOut: false, error: null });
    const h = harness(makeConfig(root));
    h.executor.handle(
      frame({ instruction: { command: 'node build', outputs: ['out.md'] }, requiredCapabilities: ['terminal_exec'] }),
      makeConfig(root),
    );
    await h.waitFor((m) => m.type === 'task_claim');
    h.executor.ack({ ok: true, assignmentId: 'lta_1', attemptNumber: 1 });
    const done = await h.waitFor((m) => m.type === 'task_complete');
    expect((done.result as { ok: boolean }).ok).toBe(true);
    const artifacts = done.artifacts as Record<string, unknown>[];
    expect(artifacts).toHaveLength(1);
    expect((artifacts[0] as { path: string }).path).toBe('out.md');
    expect((artifacts[0] as { bytes: number }).bytes).toBe('result-content'.length);
    expect((artifacts[0] as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(root, 'out.md'))).toBe(true);
    await h.settle();
  });

  it('reports an honest command failure, never PASS', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-lp-'));
    runCommandOnce.mockResolvedValue({ ok: false, output: 'boom', exitCode: 1, timedOut: false, error: 'nonzero exit' });
    const h = harness(makeConfig(root));
    h.executor.handle(frame({ instruction: { command: 'node -v' } }), makeConfig(root));
    await h.waitFor((m) => m.type === 'task_claim');
    h.executor.ack({ ok: true, assignmentId: 'lta_1', attemptNumber: 1 });
    const fail = await h.waitFor((m) => m.type === 'task_fail');
    expect(fail.errorCode).toBe('local_command_failed');
    await h.settle();
  });

  it('refuses when no workspace grants the required capability', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-lp-'));
    const noExecConfig = makeConfig(root);
    noExecConfig.workspaces = [{ root, name: 'readonly', capabilities: ['file_read'] }];
    const h = harness(noExecConfig);
    h.executor.handle(frame({ instruction: { command: 'node x' } }), noExecConfig);
    const fail = await h.waitFor((m) => m.type === 'task_fail');
    expect(fail.errorCode).toBe('capability_not_granted');
    // Refused pre-claim: no attempt frame, nothing executed.
    expect(h.sent.some((m) => m.type === 'task_claim')).toBe(false);
    expect(runCommandOnce).not.toHaveBeenCalled();
  });
});