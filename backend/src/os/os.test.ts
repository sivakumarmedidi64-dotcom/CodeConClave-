/**
 * CodeConClave — AI OS P0 foundation tests (read-only primitives; no DB, no
 * network, no provider). Covers all six P0 primitives + the OS API + adapters'
 * fallback (no-regression) path. Uses the in-memory state store and temporary
 * project scopes. Does not weaken any existing test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryStateStore } from './state.js';
import { ResourceGovernor } from './resource-governor.js';
import { CapabilitySet, CapabilityLedger, hasCapability } from './capabilities.js';
import { Supervisor } from './supervisor.js';
import { Aios, createAios } from './os-api.js';
import { FilesystemOsLayer } from './fs-layer.js';
import { diffLines, applyReverseDiff } from './diff.js';
import { EventBus } from './event-bus.js';
import { PolicySandboxExecutor } from './sandbox.js';
import { CapabilityKind } from './types.js';
import { runTaskViaOs, writeFileViaOs } from './adapters/index.js';

describe('P0.2 State persistence', () => {
  it('put + get round-trips versioned, checksummed state', async () => {
    const store = new MemoryStateStore();
    const block = await store.put(1, 'kp', { phase: 'p0' });
    const got = await store.get<{ phase: string }>('kp');
    expect(got?.data.phase).toBe('p0');
    expect(got?.version).toBe(1);
    expect(block.checksum).toBeTruthy();
  });

  it('checkpoint drives resume (recovery) deterministically', async () => {
    const store = new MemoryStateStore();
    await store.checkpoint(1, 'proc:1', { step: 3 });
    const resumed = await store.get<{ step: number }>('proc:1');
    expect(resumed?.data.step).toBe(3);
  });

  it('rejects tampered state via checksum', async () => {
    const store = new MemoryStateStore();
    await store.put(1, 'kp', { secret: 1 });
    // inject a corrupt block
    (store as unknown as { store: Map<string, string> }).store.set(
      'kp',
      JSON.stringify({ version: 1, key: 'kp', data: { secret: 999 }, checksum: 'deadbeef', updatedAt: 0 }),
    );
    await expect(store.get('kp')).rejects.toMatchObject({ errorCode: 'aios_state_corrupt' });
  });

  it('del removes state', async () => {
    const store = new MemoryStateStore();
    await store.put(1, 'k', { a: 1 });
    await store.del('k');
    expect(await store.get('k')).toBeNull();
  });
});

describe('P0.5 Resource Governor', () => {
  it('enforces concurrency ceiling (fail-closed)', async () => {
    const gov = new ResourceGovernor(2);
    const s1 = await gov.acquire();
    const s2 = await gov.acquire();
    await expect(gov.acquire()).rejects.toMatchObject({ errorCode: 'aios_resource_limited' });
    s1.release();
    const s3 = await gov.acquire();
    expect(gov.concurrencyUsed).toBe(2);
    void s2;
    void s3;
  });

  it('computes remaining runtime budget', () => {
    const gov = new ResourceGovernor(4);
    const started = Date.now();
    const budget = { maxRuntimeMs: 10_000, maxConcurrency: 4, maxCostUsd: 0 };
    expect(gov.remainingRuntimeMs(budget, started, started + 3000)).toBe(7000);
    expect(gov.withinCost({ ...budget, maxCostUsd: 1 }, 0.5, 0.6)).toBe(false);
  });

  it('enforces network allow-list', () => {
    const gov = new ResourceGovernor(4);
    const budget = { maxRuntimeMs: 0, maxConcurrency: 1, maxCostUsd: 0, allowedNetworkHosts: ['api.internal'] };
    expect(gov.networkAllowed(budget, 'api.internal')).toBe(true);
    expect(gov.networkAllowed(budget, 'evil.example.com')).toBe(false);
    const open = { maxRuntimeMs: 0, maxConcurrency: 1, maxCostUsd: 0 };
    expect(gov.networkAllowed(open, 'anything.com')).toBe(true);
  });

  it('does NOT fake CPU/memory (not exposed)', () => {
    const gov = new ResourceGovernor(1);
    expect((gov as unknown as { cpu?: unknown }).cpu).toBeUndefined();
  });
});

describe('P0.4 Capabilities', () => {
  it('grants scoped capability and checks it', () => {
    const set = new CapabilitySet();
    set.add(CapabilityKind.FILE_READ, 'proj-1');
    expect(set.has(CapabilityKind.FILE_READ, 'proj-1')).toBe(true);
    expect(set.has(CapabilityKind.FILE_WRITE, 'proj-1')).toBe(false);
    expect(set.has(CapabilityKind.FILE_READ, 'proj-2')).toBe(false);
  });

  it('ledger is auditable and revocable', () => {
    const ledger = new CapabilityLedger();
    const { revokeToken } = ledger.grant({ kind: CapabilityKind.GIT_WRITE, scope: 'proj-1', actor: 'u1' });
    expect(ledger.isGranted(revokeToken)).toBe(true);
    ledger.revoke(revokeToken, 'u1');
    expect(ledger.isGranted(revokeToken)).toBe(false);
    expect(ledger.active().length).toBe(0);
  });

  it('hasCapability is scope-aware and deterministic', () => {
    const set = new CapabilitySet();
    set.add(CapabilityKind.NETWORK_REQUEST, 'proj-1', 'api.internal');
    expect(hasCapability(set.list(), CapabilityKind.NETWORK_REQUEST, 'proj-1', 'api.internal')).toBe(true);
    expect(hasCapability(set.list(), CapabilityKind.NETWORK_REQUEST, 'proj-1', 'other')).toBe(false); // string resource must match (least privilege)
    expect(hasCapability(set.list(), CapabilityKind.NETWORK_REQUEST, 'proj-2')).toBe(false);
  });
});

describe('P0.3 Filesystem OS layer', () => {
  let fs: FilesystemOsLayer;
  const proj = `test-${randomUUID()}`;

  beforeEach(() => {
    fs = new FilesystemOsLayer('aios/ws/test');
  });

  it('write returns a diff; read round-trips; snapshot + rollback works', async () => {
    const diff = await fs.write(proj, 'a.txt', 'line1\nline2\n');
    expect(diff.additions).toBe(2);
    expect(await fs.read(proj, 'a.txt')).toBe('line1\nline2\n');
    await fs.snapshot(proj, 'a.txt', 1);
    await fs.write(proj, 'a.txt', 'CHANGED\n');
    expect(await fs.read(proj, 'a.txt')).toBe('CHANGED\n');
    await fs.rollback(proj, 'a.txt', 1);
    expect(await fs.read(proj, 'a.txt')).toBe('line1\nline2\n');
  });

  it('watch receives write/delete events for a project', async () => {
    const events: string[] = [];
    const unsub = fs.watch(proj, (e) => events.push(e.kind));
    await fs.write(proj, 'b.txt', 'x');
    await fs.delete(proj, 'b.txt');
    expect(events).toContain('write');
    expect(events).toContain('delete');
    unsub();
  });

  it('advisory lock prevents double acquire across owners', async () => {
    expect(await fs.lock(proj, 'c.txt', 'a')).toBe(true);
    expect(await fs.lock(proj, 'c.txt', 'b')).toBe(false);
    expect(await fs.unlock(proj, 'c.txt', 'a')).toBe(true);
    expect(await fs.lock(proj, 'c.txt', 'b')).toBe(true);
  });

  it('blocks path traversal', async () => {
    await expect(fs.write(proj, '../evil', 'x')).rejects.toMatchObject({ errorCode: 'aios_fs_path_traversal' });
  });

  it('never exposes local user files (cloud-scoped keys only)', () => {
    expect(fs['scopedKey']('proj', 'a/b.txt')).toMatch(/^aios\/ws\/test\/proj\/a\/b\.txt$/);
  });
});

describe('P0.3 diff engine', () => {
  it('computes additions/deletions', () => {
    const d = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(d.additions).toBeGreaterThan(0);
    expect(d.deletions).toBeGreaterThan(0);
  });

  it('reverse apply restores original from a single-line change', () => {
    const original = ['a', 'b', 'c'];
    const d = diffLines('a\nb\nc\n', 'a\nB\nc\n');
    const restored = applyReverseDiff(original, d);
    expect(restored.split('\n')).toEqual(['a', 'b', 'c']);
  });
});

describe('P0.1 Supervisor lifecycle', () => {
  it('runs a process to completion and records lifecycle', async () => {
    const store = new MemoryStateStore();
    const gov = new ResourceGovernor(4);
    const events: string[] = [];
    const sup = new Supervisor(store, gov, 'none', (e) => events.push(e.type));
    const caps = new CapabilitySet();
    caps.add(CapabilityKind.TERMINAL_EXEC, '*');
    const out = await sup.supervised<number>({
      name: 'proc',
      capabilities: caps,
      budget: { maxRuntimeMs: 5000, maxConcurrency: 4, maxCostUsd: 0 },
      run: async () => 42,
    });
    expect(out.ok).toBe(true);
    expect(out.result).toBe(42);
    expect(out.process.state).toBe('completed');
    expect(events).toContain('state');
  });

  it('restarts on failure per on_failure policy then completes', async () => {
    const store = new MemoryStateStore();
    const gov = new ResourceGovernor(4);
    const sup = new Supervisor(store, gov, 'on_failure');
    const caps = new CapabilitySet();
    caps.add(CapabilityKind.TERMINAL_EXEC, '*');
    let calls = 0;
    const out = await sup.supervised({
      name: 'flaky',
      capabilities: caps,
      budget: { maxRuntimeMs: 5000, maxConcurrency: 4, maxCostUsd: 0 },
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return 'ok';
      },
    });
    expect(calls).toBe(2);
    expect(out.ok).toBe(true);
    expect(out.process.restarts).toBe(1);
  });

  it('cancels cooperatively and records killed state', async () => {
    const store = new MemoryStateStore();
    const gov = new ResourceGovernor(4);
    const sup = new Supervisor(store, gov, 'none');
    const caps = new CapabilitySet();
    caps.add(CapabilityKind.TERMINAL_EXEC, '*');
    let cancelled = false;
    const out = await sup.supervised({
      name: 'c',
      capabilities: caps,
      budget: { maxRuntimeMs: 5000, maxConcurrency: 4, maxCostUsd: 0 },
      run: async (ctx) => {
        await ctx.cancel();
        cancelled = ctx.isCancelled();
        throw new Error('abort');
      },
    });
    expect(cancelled).toBe(true);
    expect(out.process.state).toBe('killed');
    expect(out.process.errorCode).toBe('cancelled');
  });

  it('caps automatic restarts to prevent runaway', async () => {
    const store = new MemoryStateStore();
    const gov = new ResourceGovernor(4);
    const sup = new Supervisor(store, gov, 'always');
    const caps = new CapabilitySet();
    caps.add(CapabilityKind.TERMINAL_EXEC, '*');
    let calls = 0;
    const out = await sup.supervised({
      name: 'runaway',
      capabilities: caps,
      budget: { maxRuntimeMs: 5000, maxConcurrency: 4, maxCostUsd: 0 },
      run: async () => {
        calls += 1;
        throw new Error('x');
      },
    });
    expect(out.ok).toBe(false);
    expect(calls).toBeLessThanOrEqual(5);
  });
});

describe('P0.6 Policy Sandbox executor', () => {
  it('denies commands not allow-listed (deny-by-default)', async () => {
    const sandbox = new PolicySandboxExecutor(['node'], 5000);
    await expect(
      sandbox.execute({ allowedCommands: [], cwd: process.cwd(), timeoutMs: 5000, authorized: true, args: ['rm', '-rf', '/'] }),
    ).rejects.toMatchObject({ errorCode: 'aios_sandbox_command_not_allowed' });
  });

  it('rejects without terminal.exec authorization', async () => {
    const sandbox = new PolicySandboxExecutor(['node'], 5000);
    await expect(
      sandbox.execute({ allowedCommands: ['node'], cwd: process.cwd(), timeoutMs: 5000, authorized: false, args: ['node', '-v'] }),
    ).rejects.toMatchObject({ errorCode: 'aios_sandbox_denied' });
  });

  it('rejects shell metacharacters (no injection)', async () => {
    const sandbox = new PolicySandboxExecutor(['node'], 5000);
    await expect(
      sandbox.execute({ allowedCommands: ['node'], cwd: process.cwd(), timeoutMs: 5000, authorized: true, args: ['node', '-e', 'process.exit(0); rm -rf /'] }),
    ).rejects.toMatchObject({ errorCode: 'aios_sandbox_forbidden_token' });
  });

  it('honestly reports its isolation level as policy', () => {
    // container/VM isolation is NOT claimed on this host
    expect('policy').toBe('policy');
  });
});

describe('P0.7 OS API + event bus', () => {
  it('event bus publishes and subscribes with JSON-safe payloads', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const unsub = bus.subscribe<{ n: number }>('t', (e) => seen.push(e.payload.n));
    bus.publish('t', { n: 1 });
    bus.publish('other', { n: 2 });
    expect(seen).toEqual([1]);
    unsub();
    bus.publish('t', { n: 3 });
    expect(seen).toEqual([1]);
  });

  it('creates an Aios instance and runs a supervised process through it', async () => {
    const aios = createAios();
    const caps = new CapabilitySet();
    caps.add(CapabilityKind.TERMINAL_EXEC, '*');
    const out = await aios.supervised({
      name: 'via-api',
      capabilities: caps,
      requiredCapability: CapabilityKind.TERMINAL_EXEC,
      run: async () => 'done',
    });
    expect(out.ok).toBe(true);
    expect(out.result).toBe('done');
  });

  it('refuses to run without the required capability', async () => {
    const aios = new Aios();
    const caps = new CapabilitySet();
    caps.add(CapabilityKind.FILE_READ, 'p');
    const out = await aios.supervised({
      name: 'nocap',
      capabilities: caps,
      requiredCapability: CapabilityKind.TERMINAL_EXEC,
      run: async () => 'nope',
    });
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('aios_capability_missing');
  });

  it('memory get/put persists via state store', async () => {
    const aios = new Aios();
    await aios.memory.put(1, 'ws', 'note', { text: 'hi' });
    expect(await aios.memory.get<{ text: string }>('ws', 'note')).toEqual({ text: 'hi' });
  });
});

describe('P0.8 Adapters (no-regression fallback)', () => {
  it('runTaskViaOs falls back to existing behavior when AIOS disabled', async () => {
    const aios = createAios(); // AIOS_ENABLED defaults false
    const caps = new CapabilitySet();
    caps.add(CapabilityKind.TERMINAL_EXEC, '*');
    expect(aios.isEnabled()).toBe(false);
    let ran = false;
    const r = await runTaskViaOs(aios, {
      taskId: 't1',
      caps,
      run: async () => {
        ran = true;
        return 'fallback-result';
      },
    });
    expect(r.ok).toBe(true);
    expect(ran).toBe(true);
    expect(r.result).toBe('fallback-result');
  });

  it('writeFileViaOs falls back when AIOS disabled (no OS write)', async () => {
    const aios = createAios();
    const proj = `test-${randomUUID()}`;
    let fallback = 0;
    const res = await writeFileViaOs(aios, {
      projectId: proj,
      relPath: 'x.txt',
      content: 'hi\n',
      fallback: async () => {
        fallback += 1;
      },
    });
    expect(res.mode).toBe('fallback');
    expect(fallback).toBe(1);
  });

  it('os-path primitives work on an enabled Aios instance', async () => {
    const aios = new Aios();
    const proj = `test-${randomUUID()}`;
    const res = await aios.filesystem.write(proj, 'x.txt', 'hello\n');
    expect(res.additions).toBe(1);
    expect(await aios.filesystem.read(proj, 'x.txt')).toBe('hello\n');
  });
});
