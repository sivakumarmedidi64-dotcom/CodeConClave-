/**
 * CodeConClave AI OS — RealIsolationExecutor (fail-closed facade).
 *
 * Security chain: AUTH -> CAPABILITY -> STOP RULES -> RESOURCE GOVERNOR ->
 * REAL ISOLATION -> AUDIT. This module is the REAL ISOLATION + AUDIT layer.
 *
 * It detects the strongest boundary the host can provide and FAILS CLOSED
 * when a caller demands more than the host offers:
 *   - minMode POLICY_ONLY  -> host policy execution (ProcessControls),
 *     explicitly labeled POLICY_ONLY (never presented as process/container).
 *   - minMode PROCESS      -> unshare namespace isolation, or refuse.
 *   - minMode CONTAINER    -> Docker container isolation, or refuse.
 *
 * Policy isolation is NEVER upgraded in the report: ISOLATION_MODE is the
 * detected host boundary, and every run is audited with its real mode.
 */
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { IsolationMode, satisfies, isRealIsolation } from './modes.js';
import { detectIsolationAbilities, type IsolationSnapshot } from './detect.js';
import { ContainerExecutor, type ContainerRunOptions, type ContainerRunResult } from './container-executor.js';
import {
  ProcessIsolationExecutor,
  type ProcessIsolationOptions,
  type ProcessIsolationResult,
} from './process-executor.js';
import { ProcessControls, type ProcessControlsOptions, type ProcessControlsResult } from './process-controls.js';
import { cloudMainContainerError } from './cloud-boundary.js';
import type { EventBus } from '../event-bus.js';

export interface RealIsolationRunOptions {
  /** Indispensable minimum boundary required for this run. */
  minMode?: IsolationMode;
  command: string;
  args?: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  authorized: boolean;
  /**
   * Which container/tier is executing this run:
   *  - 'main'  -> the web/API application container. ALWAYS refused
   *    (fail-closed) — the web tier never runs user programs.
   *  - 'worker'/'device' (or unspecified) -> an execution-capable worker; the
   *    normal capability + min-mode gates apply.
   */
  host?: 'main' | 'worker';
  /** Workspace id for audit correlation. */
  workspaceId?: string;
  taskId?: string;
  /** Container-only fields, used when the boundary is a container. */
  image?: string;
  hostWorkspace?: string;
  network?: 'none' | 'bridge';
  cpus?: number;
  memoryBytes?: number;
  pidsLimit?: number;
}

export type RealIsolationResult =
  | ProcessControlsResult
  | ProcessIsolationResult
  | ContainerRunResult;

export interface RealIsolationDeps {
  snapshot?: IsolationSnapshot;
  controls?: Pick<ProcessControls, 'run'>;
  container?: Pick<ContainerExecutor, 'execute'>;
  process?: Pick<ProcessIsolationExecutor, 'execute'>;
  eventBus?: Pick<EventBus, 'publish'>;
}

export class RealIsolationExecutor {
  private snapshotPromise?: Promise<IsolationSnapshot>;

  constructor(private deps: RealIsolationDeps = {}) {}

  /** Detect-and-cache the host boundary (usable for ISOLATION_MODE reporting). */
  async snapshot(): Promise<IsolationSnapshot> {
    if (this.deps.snapshot) return this.deps.snapshot;
    this.snapshotPromise ??= detectIsolationAbilities();
    return this.snapshotPromise;
  }

  /** Honest host capability report (audit/status surfaces call this). */
  async report(): Promise<{ isolationMode: IsolationMode; runtimes: string[]; note: string }> {
    const s = await this.snapshot();
    return { isolationMode: s.mode, runtimes: s.runtimes, note: s.note };
  }

  async execute(opts: RealIsolationRunOptions): Promise<RealIsolationResult> {
    if (!opts.authorized) {
      throw AppError.forbidden('aios_isolation_denied', 'caller lacks the required capability');
    }
    if (opts.host === 'main') {
      // Cloud boundary: the main app container never executes user programs.
      throw cloudMainContainerError({ command: opts.command, workspaceId: opts.workspaceId });
    }
    const minMode = opts.minMode ?? IsolationMode.POLICY_ONLY;
    const snap = await this.snapshot();
    if (!satisfies(snap.mode, minMode)) {
      throw AppError.unavailable(
        'aios_isolation_min_mode_unmet',
        `isolation requirement '${minMode}' exceeds host capability '${snap.mode}'`,
        { required: minMode, detected: snap.mode, runtimes: snap.runtimes },
      );
    }

    if (minMode === IsolationMode.POLICY_ONLY || !isRealIsolation(snap.mode)) {
      const result = await this.runPolicyOnly(opts);
      this.audit(opts, IsolationMode.POLICY_ONLY, snap);
      return result;
    }

    if (snap.mode === IsolationMode.CONTAINER || snap.mode === IsolationMode.MICROVM) {
      const result = await this.runContainer(opts);
      this.audit(opts, result.mode, snap);
      return result;
    }

    const result = await this.runProcess(opts);
    this.audit(opts, result.mode, snap);
    return result;
  }

  private runPolicyOnly(opts: RealIsolationRunOptions): Promise<ProcessControlsResult> {
    if (!this.deps.controls) return Promise.reject(this.unwired('ProcessControls'));
    const inner: ProcessControlsOptions = {
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: opts.maxOutputBytes,
      env: opts.env,
    };
    return this.deps.controls.run(inner);
  }

  private runContainer(opts: RealIsolationRunOptions): Promise<ContainerRunResult> {
    if (!this.deps.container) return Promise.reject(this.unwired('ContainerExecutor'));
    if (!opts.hostWorkspace || !opts.image) {
      return Promise.reject(
        AppError.badRequest('aios_isolation_container_config', 'container runs require image and hostWorkspace'),
      );
    }
    const inner: ContainerRunOptions = {
      image: opts.image,
      command: opts.command,
      args: opts.args,
      hostWorkspace: opts.hostWorkspace,
      network: opts.network,
      cpus: opts.cpus,
      memoryBytes: opts.memoryBytes,
      pidsLimit: opts.pidsLimit,
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: opts.maxOutputBytes,
      env: opts.env,
    };
    return this.deps.container.execute(inner);
  }

  private runProcess(opts: RealIsolationRunOptions): Promise<ProcessIsolationResult> {
    if (!this.deps.process) return Promise.reject(this.unwired('ProcessIsolationExecutor'));
    const inner: ProcessIsolationOptions = {
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: opts.maxOutputBytes,
      env: opts.env,
      authorized: true,
    };
    return this.deps.process.execute(inner);
  }

  private unwired(name: string): AppError {
    return AppError.unavailable('aios_isolation_unwired', `${name} is not wired in this host version`);
  }

  private audit(opts: RealIsolationRunOptions, mode: IsolationMode, snap: IsolationSnapshot): void {
    logger.info('aios.isolation.audit', {
      mode,
      hostMode: snap.mode,
      taskId: opts.taskId,
      workspaceId: opts.workspaceId,
      command: opts.command,
      timeoutMs: opts.timeoutMs,
    });
    try {
      this.deps.eventBus?.publish('aios.isolation', {
        mode,
        hostMode: snap.mode,
        taskId: opts.taskId,
        workspaceId: opts.workspaceId,
        command: opts.command,
        at: Date.now(),
      });
    } catch {
      /* audit emission must never break execution */
    }
  }
}