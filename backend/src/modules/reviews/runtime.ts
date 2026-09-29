/**
 * CodeConClave — B1 cowork safety review loop: runtime composition.
 *
 * Composes the CANONICAL OS primitives for the review subsystem (no parallel
 * engines, stores, schedules or permission systems):
 *   - policy sandbox executor   os/sandbox
 *   - resource governor         os/resource-governor
 *   - supervisor lifecycle      os/supervisor
 *   - stop rules                os/p2/stop-rules
 *   - state store (checkpoints) os/state
 *   - event bus                 os/event-bus
 *   - git engine                os/git
 *
 * Every enforcement channel used here is the real canonical one. The module's
 * policy is minimal: protected paths (.git, node_modules), no deletion,
 * capability-gated writes/git. Where a capability/approval/sandbox/git gate is
 * OFF in the environment, operations fail closed — never silently granted.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env } from '../../config/env.js';
import { PolicySandboxExecutor, SandboxResult } from '../../os/sandbox.js';
import { ResourceGovernor } from '../../os/resource-governor.js';
import { Supervisor } from '../../os/supervisor.js';
import { StopRules, StopRulePolicy } from '../../os/p2/stop-rules.js';
import { MemoryStateStore, StateStore } from '../../os/state.js';
import { EventBus } from '../../os/event-bus.js';
import { GitEngine, GitExecution } from '../../os/git.js';
import { Capability, RestartPolicy } from '../../os/types.js';
import { AppError } from '../../shared/errors.js';
import { canonicalize } from '../../os/p2/stop-rules.js';

export const REVIEW_PROTECTED_PATHS = [{ path: '/.git', recursive: true }, { path: '/node_modules', recursive: true }];

/** Capability set for a reviewer acting on their own workspace/project. */
export function reviewCapabilities(projectId?: string): Capability[] {
  const scope = projectId ?? 'reviews';
  return [
    { kind: 'file.read', scope, grantedAt: Date.now() },
    { kind: 'file.write', scope, grantedAt: Date.now() },
    { kind: 'terminal.exec', scope, grantedAt: Date.now() },
    { kind: 'git.read', scope, grantedAt: Date.now() },
    { kind: 'git.write', scope, grantedAt: Date.now() },
  ];
}

export function reviewStopRulePolicy(): StopRulePolicy {
  return {
    protectedPaths: REVIEW_PROTECTED_PATHS.map((p) => ({ ...p })),
    maxFilesChanged: null,
    maxRuntimeMs: null,
    allowDelete: false,
    approvalRequired: [],
    requiredCapabilities: {
      write: 'file.write',
      edit: 'file.write',
      'git.commit': 'git.write',
      'git.merge': 'git.write',
    },
  };
}

export function sandboxAllowlist(): string[] {
  const raw = env.AIOS_SANDBOX_ALLOWED_COMMANDS?.trim() ?? '';
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export interface GitFacade {
  enabled(): boolean;
  engine(cwd: string): GitEngine;
  init(cwd: string): Promise<SandboxResult>;
  addAll(cwd: string): Promise<SandboxResult>;
}

export interface ReviewRuntime {
  executor: PolicySandboxExecutor;
  governor: ResourceGovernor;
  supervisor: Supervisor;
  stopRules: StopRules;
  state: StateStore;
  events: EventBus;
  git: GitFacade;
}

export type ExecutorLike = Pick<PolicySandboxExecutor, 'execute'>;

function buildStopRules(): StopRules {
  return new StopRules(reviewStopRulePolicy(), () => 'stop_rules', { caseSensitive: false });
}

function buildExecutor(): PolicySandboxExecutor {
  return new PolicySandboxExecutor(sandboxAllowlist(), env.AIOS_SANDBOX_TIMEOUT_MS);
}

function buildGitFacade(executor: PolicySandboxExecutor): GitFacade {
  const gitEnabled = env.AIOS_GIT_ENABLED === 'true';
  const allowed = sandboxAllowlist();
  const makeExecution = (cwd: string): GitExecution => ({
    authorize: gitEnabled,
    writeCapability: true,
    allowedCommands: allowed,
    timeoutMs: env.AIOS_SANDBOX_TIMEOUT_MS,
    cwd,
    run: async (args) => {
      const r = await executor.execute({
        args,
        allowedCommands: [],
        cwd,
        timeoutMs: env.AIOS_SANDBOX_TIMEOUT_MS,
        authorized: gitEnabled,
      });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    },
  });
  return {
    enabled: () => gitEnabled,
    engine: (cwd: string) => new GitEngine(makeExecution(cwd)),
    init: async (cwd: string) =>
      executor.execute({
        args: ['git', 'init'],
        allowedCommands: [],
        cwd,
        timeoutMs: env.AIOS_SANDBOX_TIMEOUT_MS,
        authorized: gitEnabled,
      }),
    addAll: async (cwd: string) =>
      executor.execute({
        args: ['git', 'add', '--all'],
        allowedCommands: [],
        cwd,
        timeoutMs: env.AIOS_SANDBOX_TIMEOUT_MS,
        authorized: gitEnabled,
      }),
  };
}

export function buildReviewRuntime(overrides: Partial<ReviewRuntime> = {}): ReviewRuntime {
  const executor = overrides.executor ?? buildExecutor();
  const governor = overrides.governor ?? new ResourceGovernor(env.AIOS_MAX_CONCURRENCY);
  const state = overrides.state ?? new MemoryStateStore();
  const supervisor = overrides.supervisor ?? new Supervisor(state, governor, env.AIOS_DEFAULT_RESTART_POLICY as RestartPolicy);
  const stopRules = overrides.stopRules ?? buildStopRules();
  const events = overrides.events ?? new EventBus();
  const git = overrides.git ?? buildGitFacade(executor);
  return { executor, governor, supervisor, stopRules, state, events, git };
}

let activeRuntime: ReviewRuntime | null = null;
export function getRuntime(): ReviewRuntime {
  if (!activeRuntime) activeRuntime = buildReviewRuntime();
  return activeRuntime;
}

/** Test-only override for injected runtimes (executor/git/governor etc.). */
export function setReviewRuntime(rt: ReviewRuntime | null): void {
  activeRuntime = rt;
}

export function reviewWorktreeBase(): string {
  const dir = path.join(tmpdir(), 'codeconclave-reviews');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort; callers surface failures through their own paths
  }
  return dir;
}

/**
 * Materialize a review's applied files into a private temp worktree. Used by
 * RUN TESTS (sandboxed execution) and COMMIT (private worktree git). Paths are
 * validated: canonical, no traversal, no symlink-style escapes.
 */
export function materializeWorktree(reviewId: string, files: Array<{ path: string; content: string }>): string {
  const dir = mkdtempSync(path.join(reviewWorktreeBase(), `${safeReviewId(reviewId)}-`));
  for (const f of files) {
    const canonical = canonicalize(f.path);
    const relative = canonical.replace(/^\//, '');
    if (!relative || relative.includes('..')) {
      throw AppError.badRequest('review_path_invalid', 'invalid workspace path for materialization');
    }
    const target = path.join(dir, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, f.content, 'utf8');
  }
  return dir;
}

function safeReviewId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}