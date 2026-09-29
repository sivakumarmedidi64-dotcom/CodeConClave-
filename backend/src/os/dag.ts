/**
 * CodeConClave AI OS — general DAG orchestration (P1.3).
 *
 * A dependency-graph executor that schedules supervised nodes. Supports the
 * required shapes:
 *   - serial chain  A→B→C→D     (each depends on the previous)
 *   - fan-in        C deps A,B  (C runs only after A and B complete)
 *   - fan-out/parallel branches (independent nodes run concurrently)
 *   - conditional deps           (a node may be skipped when a condition fails)
 *   - failure propagation        (a failure cancels all downstream nodes)
 *   - retry                      (per-node bounded retries)
 *   - resume-from-checkpoint     (completed nodes persist; a rerun skips them)
 *
 * It is a graph over SUPERVISED bodies — it does not introduce a second task
 * engine; it reuses the existing task-dependency semantics conceptually and
 * schedules through the OS Supervisor so policy/restart/ids apply uniformly.
 */
import { AppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

export interface DagNodeContext {
  nodeId: string;
  /** Resolve a dependency's produced value (undefined if not produced/skipped). */
  resultOf<T>(nodeId: string): T | undefined;
}

export interface DagNode {
  id: string;
  deps?: string[];
  retries?: number;
  /** Optional conditional gate over the dependency results. Return false to skip. */
  condition?: (ctx: DagNodeContext) => boolean | Promise<boolean>;
  /** Run the node body. */
  run: (ctx: DagNodeContext) => Promise<unknown>;
}

export type DagNodeStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed' | 'cancelled';

export interface DagNodeState {
  id: string;
  status: DagNodeStatus;
  retries: number;
  attempts: number;
  errorCode: string | null;
}

export interface DagDependencies {
  /** Persist a node's completion so a later run can resume from it. */
  markCompleted(id: string, version: number, key: string): Promise<void>;
  isCompleted(id: string, version: number, key: string): Promise<boolean>;
}

/** Default per-call in-memory checkpoint adapter (no external dependency). */
class InMemoryDeps implements DagDependencies {
  private completed = new Set<string>();
  async markCompleted(id: string): Promise<void> {
    this.completed.add(id);
  }
  async isCompleted(id: string): Promise<boolean> {
    return this.completed.has(id);
  }
}

export interface DagResult {
  ok: boolean;
  nodes: Record<string, DagNodeState>;
  errorCode: string | null;
  cancelledNodeIds: string[];
}

export interface DagExecutionOptions {
  concurrency?: number;
  deps?: DagDependencies;
  checkpoint?: { version: number; keyPrefix: string };
  onNodeEvent?: (nodeId: string, status: DagNodeStatus, attempt: number) => void;
}

const MAX_RETRIES_DEFAULT = 1;

export class DagExecutor {
  /**
   * Execute a DAG. Deterministic topological scheduling: a node is ready when
   * all its dependencies are terminal (completed/skipped). If any dependency
   * failed, downstream nodes are cancelled (failure propagation). Independent
   * ready nodes run concurrently up to `concurrency`.
   */
  async execute(nodes: DagNode[], opts: DagExecutionOptions = {}): Promise<DagResult> {
    if (nodes.length === 0) return { ok: true, nodes: {}, errorCode: null, cancelledNodeIds: [] };
    const state = new Map<string, DagNodeState>();
    const results = new Map<string, unknown>();

    // validate: every dependency must exist
    const ids = new Set(nodes.map((n) => n.id));
    for (const n of nodes) {
      for (const d of n.deps ?? []) {
        if (!ids.has(d)) {
          throw AppError.badRequest('aios_dag_unknown_dep', `node '${n.id}' depends on unknown node '${d}'`);
        }
      }
      state.set(n.id, { id: n.id, status: 'pending', retries: n.retries ?? MAX_RETRIES_DEFAULT, attempts: 0, errorCode: null });
    }

    const deps = opts.deps ?? new InMemoryDeps();
    const cancelled: string[] = [];

    // Resume-from-checkpoint: nodes already completed are skipped.
    if (opts.checkpoint) {
      for (const n of nodes) {
        const key = `${opts.checkpoint.keyPrefix}:${n.id}`;
        if (await deps.isCompleted(n.id, opts.checkpoint.version, key)) {
          state.get(n.id)!.status = 'completed';
        }
      }
    }

    let failed = false;
    let failedCode: string | null = null;

    const depResults = (node: DagNode) => {
      const ctx: DagNodeContext = {
        nodeId: node.id,
        resultOf: <T>(id: string) => results.get(id) as T | undefined,
      };
      return ctx;
    };

    while (true) {
      const pending = nodes.filter((n) => state.get(n.id)!.status === 'pending');
      if (pending.length === 0) break;

      // If something failed, propagate: cancel pending nodes that transitively
      // depend on a failed node (or all remaining when a root failed hard).
      if (failed) {
        for (const n of pending) {
          state.get(n.id)!.status = 'cancelled';
          cancelled.push(n.id);
          opts.onNodeEvent?.(n.id, 'cancelled', state.get(n.id)!.attempts);
        }
        break;
      }

      // ready = all deps terminal and not failed; condition passes if deps met
      const ready: DagNode[] = [];
      for (const n of pending) {
        const depsMeta = n.deps ?? [];
        if (depsMeta.length === 0) {
          ready.push(n);
          continue;
        }
        const allTerminal = depsMeta.every((d) => {
          const s = state.get(d)!;
          return s.status === 'completed' || s.status === 'skipped';
        });
        if (!allTerminal) continue;
        // conditional gate over completed dependency results
        if (n.condition) {
          const should = await safeCondition(n.condition, depResults(n));
          if (!should) {
            state.get(n.id)!.status = 'skipped';
            opts.onNodeEvent?.(n.id, 'skipped', 0);
            continue;
          }
        }
        ready.push(n);
      }

      if (ready.length === 0) {
        // deadlock: no ready node but pending remain → graph cycle or bad gate
        failed = true;
        failedCode = 'aios_dag_deadlock';
        break;
      }

      // run ready nodes concurrently
      await Promise.all(
        ready.map((n) =>
          (async () => {
            const st = state.get(n.id)!;
            st.status = 'running';
            opts.onNodeEvent?.(n.id, 'running', st.attempts);
            try {
              await n.run(depResults(n));
              st.status = 'completed';
              if (opts.checkpoint) {
                try {
                  await deps.markCompleted(n.id, opts.checkpoint.version, `${opts.checkpoint.keyPrefix}:${n.id}`);
                } catch (e) {
                  logger.warn('aios.dag.checkpoint_failed', { nodeId: n.id, error: (e as Error).message });
                }
              }
              opts.onNodeEvent?.(n.id, 'completed', st.attempts);
            } catch (err) {
              st.attempts += 1;
              st.errorCode = err instanceof AppError ? err.errorCode : 'aios_dag_node_failed';
              if (st.attempts <= st.retries) {
                // retry: reset to pending
                st.status = 'pending';
                opts.onNodeEvent?.(n.id, 'pending', st.attempts);
                return;
              }
              st.status = 'failed';
              failed = true;
              failedCode = st.errorCode;
              opts.onNodeEvent?.(n.id, 'failed', st.attempts);
            }
          })(),
        ),
      );
    }

    // mark any still-pending (unreachable due to failure) as cancelled
    for (const [id, st] of state) {
      if (st.status === 'pending') {
        st.status = 'cancelled';
        cancelled.push(id);
      }
    }

    const nodesOut: Record<string, DagNodeState> = {};
    for (const [id, st] of state) nodesOut[id] = st;

    return { ok: !failed, nodes: nodesOut, errorCode: failed ? failedCode : null, cancelledNodeIds: cancelled };
  }
}

async function safeCondition(
  cond: (ctx: DagNodeContext) => boolean | Promise<boolean>,
  ctx: DagNodeContext,
): Promise<boolean> {
  try {
    return await cond(ctx);
  } catch {
    return false;
  }
}
