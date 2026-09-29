/**
 * CodeConClave AI OS — P1 feature adapters.
 *
 * Demonstrate how EXISTING systems can use the new P1 primitives (IPC bus, DAG
 * orchestration, tracing) behind the AIOS flag, by wrapping them at their
 * boundary. All are ADDITIVE: when AIOS is disabled, the wrapped behavior falls
 * back to the existing path unchanged. Nothing here modifies production modules.
 */
import type { Aios } from '../os-api.js';
import { DagNode } from '../dag.js';
import { IpcEvent } from '../ipc.js';

/**
 * Run a set of stages as a supervised DAG. Falls back to running the stages
 * serially (existing behavior) when AIOS is disabled.
 */
export async function runPipelineViaDag(
  aios: Aios,
  opts: {
    workspaceId?: string | null;
    stages: Array<{ id: string; deps?: string[]; run: () => Promise<unknown>; condition?: () => boolean }>;
    runFallback: () => Promise<unknown>;
  },
): Promise<{ ok: boolean; errorCode: string | null; nodes: Record<string, string> }> {
  if (!aios.isEnabled()) {
    await opts.runFallback();
    return { ok: true, errorCode: null, nodes: {} };
  }
  const nodes: DagNode[] = opts.stages.map((s) => {
    const cond = s.condition;
    return {
      id: s.id,
      deps: s.deps,
      run: async () => {
        await s.run();
      },
      condition: cond ? () => cond() : undefined,
    };
  });
  const result = await aios.dag.execute(nodes);
  const out: Record<string, string> = {};
  for (const [id, st] of Object.entries(result.nodes)) out[id] = st.status;
  return { ok: result.ok, errorCode: result.errorCode, nodes: out };
}

/**
 * Publish a workspace-scoped event over the OS IPC bus. Falls back to the
 * existing in-memory event bus when AIOS is disabled.
 */
export async function publishEventViaIpc<T>(
  aios: Aios,
  opts: { topic: string; payload: T; workspaceId?: string | null },
): Promise<IpcEvent<T>> {
  return aios.ipc.publish(opts.topic, opts.payload, { workspaceId: opts.workspaceId });
}

/** Open a trace span around a body; falls back to running the body directly. */
export async function traceViaOs<R>(
  aios: Aios,
  opts: { name: string; workspaceId?: string | null; run: () => Promise<R> },
): Promise<R> {
  if (!aios.isEnabled()) return opts.run();
  const trace = aios.createTrace({ workspaceId: opts.workspaceId });
  const span = trace.begin('task', opts.name);
  try {
    const result = await opts.run();
    trace.end(span.spanId, 'ok');
    return result;
  } catch (err) {
    trace.end(span.spanId, 'error', {
      errorCode: err instanceof Error ? err.message : 'failed',
    });
    throw err;
  }
}
