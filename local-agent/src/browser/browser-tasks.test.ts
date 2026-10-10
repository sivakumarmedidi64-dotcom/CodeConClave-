/**
 * CodeConClave Local Agent — browser instruction executor tests.
 *
 * The browser runner itself is exercised against a real headless browser in
 * controller.e2e.test.ts. These tests prove the executor routing:
 *  - a browser instruction is routed to the browser runner and its real
 *    outcome + artifacts are reported as task_complete;
 *  - a denied browser action fails with the exact errorCode the runner gives;
 *  - a browser instruction without the required browser.* grant is refused
 *    before any claim (never executed);
 *  - a build without a browser runner refuses with `browser_not_enabled`.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalTaskExecutor, type LocalTaskExecutor } from '../tasks.js';
import type { AgentConfig } from '../config.js';

function makeConfig(root: string, browser = true): AgentConfig {
  return {
    version: '0.1.0',
    deviceId: 'dev_1',
    deviceSecretHash: 'x',
    createdAt: new Date().toISOString(),
    pairedTo: 'http://localhost:4000',
    token: 't',
    workspaces: [{ root, name: 'ws', capabilities: ['file_read', 'file_write', 'terminal_exec'] }],
    browser: browser
      ? [{ name: 'qa', capabilities: ['browser.open', 'browser.read', 'browser.inspect', 'browser.click', 'browser.type', 'browser.submit'], allowedOrigins: ['*'] }]
      : [],
  };
}

function frame(task: Record<string, unknown>): Record<string, unknown> {
  return { assignmentId: 'lta_1', leaseExpiresAt: new Date().toISOString(), task: { id: 'tsk_1', ...task } };
}

const BROWSER_TASK = {
  title: 'Open example',
  requiredCapabilities: ['browser.open', 'browser.read'],
  instruction: { type: 'browser', grants: { capabilities: ['browser.open', 'browser.read'], allowedOrigins: ['*'], lifetimeMs: 3600_000 }, actions: [{ op: 'open', url: 'https://example.com/' }] },
};

interface Harness {
  sent: Record<string, unknown>[];
  executor: LocalTaskExecutor;
  waitFor: (pred: (m: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  ackClaim: () => Promise<void>;
}

function harness(config: AgentConfig, runner?: ReturnType<typeof vi.fn>): Harness {
  const sent: Record<string, unknown>[] = [];
  const executor = createLocalTaskExecutor((m) => sent.push(m), runner as never);
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
  const ackClaim = async () => {
    const claim = await waitFor((m) => m.type === 'task_claim');
    executor.ack({ ok: true, assignmentId: String(claim.assignmentId), attemptNumber: 1 });
  };
  return { sent, executor, waitFor, ackClaim };
}

describe('browser instruction executor', () => {
  it('routes a browser instruction to the runner and reports its real outcome + artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-bt-'));
    const runner = vi.fn().mockResolvedValue({
      ok: true,
      errorCode: undefined,
      error: undefined,
      summary: { ok: true, actions: 1, finalUrl: 'https://example.com/' },
      artifacts: [{ kind: 'browser_screenshot', path: 'browser-downloads/lta_1/evidence/01.png', absPath: join(root, 'browser-downloads', 'lta_1', 'x.png'), bytes: 123, sha256: 'a'.repeat(64) }],
    });
    const h = harness(makeConfig(root), runner);
    h.executor.handle(frame(BROWSER_TASK), makeConfig(root));
    await h.ackClaim();
    const done = await h.waitFor((m) => m.type === 'task_complete');
    expect((done.result as { ok: boolean }).ok).toBe(true);
    expect(done.artifacts).toHaveLength(1);
    expect(runner).toHaveBeenCalledTimes(1);
    const call = runner.mock.calls[0]!;
    expect((call[0] as { type: string }).type).toBe('browser');
    h.executor.ack({ ok: true, assignmentId: 'lta_1' });
  });

  it('reports a denied/failed browser action with the runner errorCode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-bt-'));
    const runner = vi.fn().mockResolvedValue({
      ok: false,
      errorCode: 'browser_action_failed',
      error: JSON.stringify({ actionIndex: 0, op: 'submit', reason: 'denied: current page is an auth/payment surface' }),
      summary: { ok: false, actionsAttempted: 1, lastError: 'denied' },
      artifacts: [],
    });
    const h = harness(makeConfig(root), runner);
    h.executor.handle(frame(BROWSER_TASK), makeConfig(root));
    await h.ackClaim();
    const fail = await h.waitFor((m) => m.type === 'task_fail');
    expect(fail.errorCode).toBe('browser_action_failed');
    expect(String(fail.error)).toContain('"op":"submit"');
    h.executor.ack({ ok: true, assignmentId: 'lta_1' });
    expect(h.sent.some((m) => m.type === 'task_complete')).toBe(false);
  });

  it('refuses a browser instruction pre-claim when the browser capabilities are not granted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-bt-'));
    const cfg = makeConfig(root, false);
    const h = harness(cfg, vi.fn());
    h.executor.handle(frame(BROWSER_TASK), cfg);
    const fail = await h.waitFor((m) => m.type === 'task_fail');
    expect(fail.errorCode).toBe('capability_not_granted');
    expect(h.sent.some((m) => m.type === 'task_claim')).toBe(false);
  });

  it('refuses with browser_not_enabled when the build has no runner wired', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-bt-'));
    const cfg = makeConfig(root);
    const sent: Record<string, unknown>[] = [];
    const executor = createLocalTaskExecutor((m) => sent.push(m));
    executor.handle(frame(BROWSER_TASK), cfg);
    const start = Date.now();
    const waitFor = (pred: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const tick = () => {
          const found = sent.find(pred);
          if (found) return resolve(found);
          if (Date.now() - start > 2000) return reject(new Error('timeout'));
          setTimeout(tick, 5);
        };
        tick();
      });
    const fail = await waitFor((m) => m.type === 'task_fail');
    expect(fail.errorCode).toBe('browser_not_enabled');
    expect(sent.some((m) => m.type === 'task_claim')).toBe(false);
  });
});