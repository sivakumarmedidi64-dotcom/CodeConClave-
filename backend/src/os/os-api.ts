/**
 * CodeConClave AI OS — OS core API (P0.7).
 *
 * A single internal OS API that future features use. Wire together the P0
 * primitives (supervisor, state, filesystem, capabilities, resource governor,
 * sandbox) plus a lightweight memory and scheduler shim, all additive and
 * feature-flag-gated. When AIOS is disabled, osApi.isEnabled() returns false
 * and callers fall back to existing behavior (no regression).
 */
import { env } from '../config/env.js';
import { logger } from '../shared/logger.js';
import { MemoryStateStore, StateStore } from './state.js';
import { ResourceGovernor } from './resource-governor.js';
import { Supervisor, SuperviseContext, SuperviseOptions, SuperviseOutcome, LifecycleEvent } from './supervisor.js';
import { CapabilitySet, CapabilityLedger } from './capabilities.js';
import { FilesystemOsLayer } from './fs-layer.js';
import { EventBus, OsEvent } from './event-bus.js';
import { PolicySandboxExecutor, SandboxOptions, SandboxResult } from './sandbox.js';
import { IpcBus, MemoryIpcStore, OutboxIpcStore } from './ipc.js';
import { DagExecutor, DagNode } from './dag.js';
import { Trace } from './observability.js';
import { GitEngine } from './git.js';
import { ProcessTree } from './lifecycle.js';
import {
  Capability,
  CapabilityKind,
  OsProcess,
  OsProcessState,
  ResourceBudget,
  RestartPolicy,
} from './types.js';

export interface AiosContext {
  isEnabled(): boolean;
  state: StateStore;
  governor: ResourceGovernor;
  supervisor: Supervisor;
  capabilities: CapabilityLedger;
  filesystem: FilesystemOsLayer;
  events: EventBus;
  sandbox: PolicySandboxExecutor;
  ipc: IpcBus;
  dag: DagExecutor;
  /** Observability / tracing factory (P1). */
  createTrace(seed?: { workspaceId?: string | null; coworkId?: string | null }): Trace;
  /** Safe, policy-gated Git engine (P1). Fails closed when git is disabled. */
  git: GitEngine;
  /** Tracked child-process tree for cleanup / propagation (P1). */
  processTree: ProcessTree;
  memory: {
    get<T>(scope: string, key: string): Promise<T | null>;
    put<T>(version: number, scope: string, key: string, data: T): Promise<void>;
  };
  scheduler: {
    enqueue(priority: number): number;
    priority(token: number, priority: number): void;
  };
  defaultBudget: ResourceBudget;
  allowedCommands: string[];
}

export class Aios implements AiosContext {
  readonly state: StateStore;
  readonly governor: ResourceGovernor;
  readonly supervisor: Supervisor;
  readonly capabilities = new CapabilityLedger();
  readonly filesystem: FilesystemOsLayer;
  readonly events = new EventBus();
  readonly sandbox: PolicySandboxExecutor;
  readonly ipc: IpcBus;
  readonly dag = new DagExecutor();
  readonly processTree = new ProcessTree();
  readonly git: GitEngine;
  readonly memory: AiosContext['memory'];
  readonly scheduler: AiosContext['scheduler'];
  readonly defaultBudget: ResourceBudget;
  readonly allowedCommands: string[];

  constructor(opts?: { stateStore?: StateStore; filesystemScope?: string; gitWorkspace?: string }) {
    this.state = opts?.stateStore ?? new MemoryStateStore();
    this.governor = new ResourceGovernor(env.AIOS_MAX_CONCURRENCY);
    this.supervisor = new Supervisor(
      this.state,
      this.governor,
      env.AIOS_DEFAULT_RESTART_POLICY as RestartPolicy,
      (ev) => {
        // Surface lifecycle events onto the bus (topic:topic not used; single log stream)
        this.events.publish('aios.lifecycle', { proc: ev.processId, type: ev.type });
      },
    );
    this.filesystem = new FilesystemOsLayer(opts?.filesystemScope ?? 'aios/ws');

    const allowed = env.AIOS_SANDBOX_ALLOWED_COMMANDS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.allowedCommands = allowed;
    this.sandbox = new PolicySandboxExecutor(allowed, env.AIOS_SANDBOX_TIMEOUT_MS);

    // P1.1 durable IPC: memory store by default; outbox-backed when enabled.
    const ipcDurable = env.AIOS_IPC_DURABLE === 'true';
    this.ipc = new IpcBus(ipcDurable ? new OutboxIpcStore(true) : new MemoryIpcStore());

    // P1.4 safe git engine routed through the policy sandbox. Fails closed when
    // AIOS_GIT_ENABLED !== 'true' or `git` is not allow-listed.
    const gitEnabled = env.AIOS_GIT_ENABLED === 'true';
    const gitCwd = opts?.gitWorkspace ?? (typeof process !== 'undefined' ? process.cwd() : '.');
    this.git = new GitEngine({
      authorize: gitEnabled,
      writeCapability: gitEnabled,
      allowedCommands: gitEnabled ? allowed : [],
      timeoutMs: env.AIOS_SANDBOX_TIMEOUT_MS,
      cwd: gitCwd,
      run: (args) =>
        this.sandbox.execute({
          args,
          allowedCommands: [],
          timeoutMs: env.AIOS_SANDBOX_TIMEOUT_MS,
          cwd: gitCwd,
          authorized: gitEnabled,
        }),
    });

    this.defaultBudget = {
      maxRuntimeMs: env.AIOS_MAX_RUNTIME_MS,
      maxConcurrency: env.AIOS_MAX_CONCURRENCY,
      maxCostUsd: env.AIOS_MAX_COST_USD,
      priority: 0,
    };

    this.memory = {
      get: async <T>(scope: string, key: string): Promise<T | null> => {
        const block = await this.state.get<T>(`os:mem:${scope}:${key}`);
        return block?.data ?? null;
      },
      put: async <T>(version: number, scope: string, key: string, data: T): Promise<void> => {
        await this.state.put(version, `os:mem:${scope}:${key}`, data);
      },
    };

    this.scheduler = {
      enqueue: (priority: number): number => {
        // The DB-backed task table is the real scheduler; the OS shim assigns
        // a priority token that orchestrators can map onto task.priority.
        return priority;
      },
      priority: (token: number, priority: number): void => {
        void token;
        void priority;
      },
    };
  }

  isEnabled(): boolean {
    return env.AIOS_ENABLED === 'true';
  }

  assertEnabled(): void {
    if (!this.isEnabled()) {
      logger.warn('aios.disabled', { action: 'os-api-call' });
    }
  }

  /** Create a trace (P1.5) that flows correlation/workspace/cowork identifiers. */
  createTrace(seed?: { workspaceId?: string | null; coworkId?: string | null }): Trace {
    return new Trace(seed);
  }

  /**
   * Run a supervised process through the OS. When AIOS is disabled this simply
   * runs the body once without OS supervision (no regression). Requires the
   * caller to hold required capabilities.
   */
  async supervised<R>(
    opts: {
      name: string;
      parentId?: string | null;
      capabilities: Capability[] | CapabilitySet;
      requiredCapability: CapabilityKind | string;
      budget?: Partial<ResourceBudget>;
      restartPolicy?: RestartPolicy;
      maxRestarts?: number;
      backoffBaseMs?: number;
      run: (ctx: SuperviseContext) => Promise<R>;
    },
  ): Promise<SuperviseOutcome<R>> {
    const caps = opts.capabilities instanceof CapabilitySet ? opts.capabilities.list() : opts.capabilities;
    const has = caps.some((c) => c.kind === opts.requiredCapability);
    if (!has) {
      logger.warn('aios.capability.missing', { required: opts.requiredCapability, name: opts.name });
      return {
        process: {
          id: 'n/a',
          parentId: opts.parentId ?? null,
          state: 'failed',
          restartPolicy: opts.restartPolicy ?? 'none',
          capabilities: caps,
          pid: null,
          createdAt: Date.now(),
          startedAt: null,
          finishedAt: null,
          attempts: 0,
          errorCode: 'aios_capability_missing',
          restarts: 0,
        },
        result: null,
        ok: false,
        errorCode: 'aios_capability_missing',
        restarts: 0,
      };
    }

    return this.supervisor.supervised<R>({
      name: opts.name,
      parentId: opts.parentId ?? null,
      capabilities: caps,
      budget: this.governor.resolve(this.defaultBudget, opts.budget),
      restartPolicy: opts.restartPolicy,
      maxRestarts: opts.maxRestarts ?? (env.AIOS_MAX_RESTARTS > 0 ? env.AIOS_MAX_RESTARTS : undefined),
      backoffBaseMs: opts.backoffBaseMs ?? env.AIOS_BACKOFF_BASE_MS,
      run: opts.run,
    });
  }
}

export function createAios(): Aios {
  const aios = new Aios();
  if (aios.isEnabled()) {
    logger.info('aios.enabled', {
      sandboxCommands: aios.allowedCommands.length,
      maxConcurrency: aios.governor.maxConcurrency(),
    });
  } else {
    logger.info('aios.disabled', { hint: 'set AIOS_ENABLED=true to activate the OS foundation' });
  }
  return aios;
}

export type { OsProcess, OsProcessState, CapabilityKind, ResourceBudget, RestartPolicy, OsEvent, SandboxResult, SandboxOptions };
