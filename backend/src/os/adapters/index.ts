/**
 * CodeConClave AI OS — adapters (P0.8).
 *
 * Demonstrate that EXISTING systems can use the new OS primitives by wrapping
 * them behind the AIOS flag. When AIOS is disabled, every adapter falls back to
 * the existing behavior it wrapped (no regression). The wrappers are ADDITIVE:
 * they do not modify the implementation of the production modules; they sit at
 * their boundary.
 */
import type { Aios } from '../os-api.js';
import { CapabilitySet, CapabilityKind } from '../index.js';

/** Wrap an existing task-execution body with OS supervision (supervisor + capability). */
export async function runTaskViaOs<R>(
  aios: Aios,
  opts: { taskId: string; caps: CapabilitySet; run: () => Promise<R> },
): Promise<{ ok: boolean; errorCode: string | null; result: R | null }> {
  if (!aios.isEnabled()) {
    // Fallback: existing path unchanged.
    try {
      const result = await opts.run();
      return { ok: true, errorCode: null, result };
    } catch (err) {
      return { ok: false, errorCode: (err as Error).message || 'failed', result: null };
    }
  }
  const outcome = await aios.supervised<R>({
    name: `task:${opts.taskId}`,
    capabilities: opts.caps,
    requiredCapability: CapabilityKind.TERMINAL_EXEC,
    run: opts.run,
  });
  return { ok: outcome.ok, errorCode: outcome.errorCode, result: outcome.result };
}

/** Wrap an existing memory-write flow with OS state persistence + capability. */
export async function putMemoryViaOs<T>(
  aios: Aios,
  opts: { scope: string; key: string; version: number; data: T; assign: (value: T) => Promise<void> },
): Promise<'os' | 'fallback'> {
  if (!aios.isEnabled()) {
    await opts.assign(opts.data);
    return 'fallback';
  }
  await aios.memory.put(opts.version, opts.scope, opts.key, opts.data);
  return 'os';
}

/** Wrap an existing filesystem-write flow with OS fs layer (cloud-scoped). */
export async function writeFileViaOs(
  aios: Aios,
  opts: {
    projectId: string;
    relPath: string;
    content: string;
    fallback: () => Promise<unknown>;
  },
): Promise<{ mode: 'os' | 'fallback'; diff: { additions: number; deletions: number } }> {
  if (!aios.isEnabled()) {
    await opts.fallback();
    return { mode: 'fallback', diff: { additions: 0, deletions: 0 } };
  }
  const diff = await aios.filesystem.write(opts.projectId, opts.relPath, opts.content);
  return { mode: 'os', diff: { additions: diff.additions, deletions: diff.deletions } };
}

/**
 * Demonstrate the agent-worker path: a worker heartbeats + runs through the OS
 * supervisor. When disabled, the body is invoked directly (existing behavior).
 */
export async function agentWorkerViaOs<R>(
  aios: Aios,
  opts: { workerId: string; caps: CapabilitySet; run: () => Promise<R> },
): Promise<{ ok: boolean; errorCode: string | null }> {
  if (!aios.isEnabled()) {
    await opts.run();
    return { ok: true, errorCode: null };
  }
  const outcome = await aios.supervised<R>({
    name: `worker:${opts.workerId}`,
    capabilities: opts.caps,
    requiredCapability: CapabilityKind.TERMINAL_EXEC,
    run: opts.run,
  });
  return { ok: outcome.ok, errorCode: outcome.errorCode };
}
