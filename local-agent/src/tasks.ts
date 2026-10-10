/**
 * CodeConClave Local Agent — P0 local task executor.
 *
 * Executes a task assignment frame pushed by the cloud hub over the /agent
 * WebSocket. Flow: capability check → claim → heartbeats → policy-gated run of
 * an explicit `instruction` (command within a granted workspace) → report the
 * REAL result (success or failure) plus real artifact references. A task with
 * no executable instruction is FAILED HONESTLY (`no_local_instruction`) — the
 * fabric never fabricates completion. Autonomous goal execution arrives in
 * later phases; this is the verified execution boundary.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig, WorkspaceGrant } from './config.js';
import { resolveWorkspacePath, gateTerminalInput, classifyCommand } from './policy.js';
import { runCommandOnce } from './terminal.js';
import { desktopGrantedCaps, desktopRequiredCapabilities } from './desktop/runner.js';

const DEFAULT_SHELL = process.platform === 'win32' ? 'powershell' : 'bash';
const HEARTBEAT_MS = 30_000;
const ACK_TIMEOUT_MS = 10_000;

export interface TaskAckMessage {
  ok?: boolean;
  assignmentId?: unknown;
  attemptNumber?: unknown;
  decision?: unknown;
  error?: unknown;
}

export interface LocalTaskExecutor {
  /** Handle an inbound `task_assign` frame. */
  handle: (frame: Record<string, unknown>, config: AgentConfig) => void;
  /** Route an inbound `task_ack` frame to the awaiting task (if any). */
  ack: (msg: Record<string, unknown>) => void;
}

/** Outcome contract shared by the terminal and browser executors. */
export interface ExecutionOutcome {
  ok: boolean;
  errorCode?: string;
  error?: string;
  summary: Record<string, unknown>;
  artifacts: Record<string, unknown>[];
}

export type BrowserRunner = (
  instruction: Record<string, unknown>,
  config: AgentConfig,
  assignmentId: string,
  attemptNumber: number,
) => Promise<ExecutionOutcome>;

export type DesktopRunner = BrowserRunner;

export function createLocalTaskExecutor(send: (msg: Record<string, unknown>) => void, browserRunner?: BrowserRunner, desktopRunner?: DesktopRunner): LocalTaskExecutor {
  const acks = new Map<string, (msg: TaskAckMessage) => void>();
  const running = new Set<string>();

  const awaitAck = (assignmentId: string): Promise<TaskAckMessage> =>
    new Promise<TaskAckMessage>((resolve) => {
      const timer = setTimeout(() => stop(), ACK_TIMEOUT_MS);
      const stop = () => {
        clearTimeout(timer);
        acks.delete(assignmentId);
        resolve({ ok: false, assignmentId, error: 'ack_timeout' });
      };
      acks.set(assignmentId, (msg) => {
        clearTimeout(timer);
        acks.delete(assignmentId);
        resolve(msg);
      });
    });

  return {
    handle: (frame, config) => {
      void executeTask(frame, config, send, awaitAck, running, browserRunner, desktopRunner);
    },
    ack: (msg) => {
      const key = String(msg.assignmentId ?? '');
      const fn = acks.get(key);
      if (fn) {
        acks.delete(key);
        fn(msg as TaskAckMessage);
      } else if (msg.ok === false && running.has(key)) {
        // The cloud refused the assignment (superseded / not active): the local
        // copy must stop, not keep executing a task the cloud no longer owns.
        running.delete(key);
        send({ type: 'task_progress', assignmentId: key, progress: { stopped: 'superseded' } });
      }
    },
  };
}

async function executeTask(
  frame: Record<string, unknown>,
  config: AgentConfig,
  send: (msg: Record<string, unknown>) => void,
  awaitAck: (assignmentId: string) => Promise<TaskAckMessage>,
  running: Set<string>,
  browserRunner?: BrowserRunner,
  desktopRunner?: DesktopRunner,
): Promise<void> {
  const assignmentId = String(frame.assignmentId ?? '');
  const task = (frame.task ?? {}) as Record<string, unknown>;
  if (!assignmentId || !task.id) return;
  if (running.has(assignmentId)) return;

  const instruction = (task.instruction as Record<string, unknown> | undefined) ?? null;
  const isBrowser = instruction?.type === 'browser';
  const isDesktop = instruction?.type === 'desktop';
  const required = Array.isArray(task.requiredCapabilities)
    ? (task.requiredCapabilities as string[])
    : isBrowser
      ? browserCapsFrom(instruction)
      : isDesktop
        ? desktopRequiredCapabilities(instruction)
        : ['terminal_exec'];

  // Capability check is per-kind: browser instructions need browser.* grants,
  // desktop instructions need desktop.* grants, terminal instructions need a
  // workspace with terminal_exec. Never cross-grants between surfaces.
  const granted = isBrowser ? browserGrantedCaps(config) : isDesktop ? desktopGrantedCaps(config) : [...(pickWorkspace(config)?.capabilities ?? [])];
  const missing = required.filter((cap) => !granted.includes(cap));
  if (missing.length > 0) {
    send({
      type: 'task_fail',
      assignmentId,
      errorCode: 'capability_not_granted',
      error: `No granted ${isBrowser ? 'browser' : isDesktop ? 'desktop' : 'workspace'} grant provides ${missing.join(', ')} — task refused`,
    });
    return;
  }
  if (isBrowser && !browserRunner) {
    send({
      type: 'task_fail',
      assignmentId,
      errorCode: 'browser_not_enabled',
      error: 'This agent build has no browser runner wired (started without browser support)',
    });
    return;
  }
  if (isDesktop && !desktopRunner) {
    send({
      type: 'task_fail',
      assignmentId,
      errorCode: 'desktop_not_enabled',
      error: 'This agent build has no desktop runner wired (started without desktop support)',
    });
    return;
  }

  send({ type: 'task_claim', assignmentId });
  const claim = await awaitAck(assignmentId);
  if (!claim.ok || typeof claim.attemptNumber !== 'number') {
    return; // not ours — the cloud owns the decision
  }
  const attemptNumber = claim.attemptNumber;
  running.add(assignmentId);

  const heartbeat = setInterval(() => {
    if (!running.has(assignmentId)) return;
    send({ type: 'task_heartbeat', assignmentId, attemptNumber });
  }, HEARTBEAT_MS);

  const stop = () => {
    clearInterval(heartbeat);
    running.delete(assignmentId);
  };

  try {
    const instruction = (task.instruction as Record<string, unknown> | undefined) ?? null;

    if (instruction?.type === 'desktop' && desktopRunner) {
      const outcome = await desktopRunner(instruction, config, assignmentId, attemptNumber);
      if (!running.has(assignmentId)) return;
      sendProgress(send, assignmentId, attemptNumber, {
        step: 'finished',
        ok: outcome.ok,
        errorCode: outcome.errorCode ?? null,
        actionsAttempted: outcome.summary.actionsAttempted ?? null,
      });
      if (!outcome.ok) {
        send({
          type: 'task_fail',
          assignmentId,
          attemptNumber,
          errorCode: outcome.errorCode ?? 'desktop_execution_failed',
          error: String(outcome.error ?? 'desktop execution failed').slice(0, 2000),
        });
        await awaitAck(assignmentId);
        stop();
        return;
      }
      send({
        type: 'task_complete',
        assignmentId,
        attemptNumber,
        result: { ok: true, ...outcome.summary },
        artifacts: outcome.artifacts ?? [],
      });
      await awaitAck(assignmentId);
      stop();
      return;
    }

    if (instruction?.type === 'browser' && browserRunner) {
      const outcome = await browserRunner(instruction, config, assignmentId, attemptNumber);
      if (!running.has(assignmentId)) return;
      sendProgress(send, assignmentId, attemptNumber, {
        step: 'finished',
        ok: outcome.ok,
        errorCode: outcome.errorCode ?? null,
        actionsAttempted: outcome.summary.actionsAttempted ?? null,
        evidence: Array.isArray(outcome.artifacts) ? outcome.artifacts.length : 0,
      });
      if (!outcome.ok) {
        send({
          type: 'task_fail',
          assignmentId,
          attemptNumber,
          errorCode: outcome.errorCode ?? 'browser_execution_failed',
          error: String(outcome.error ?? 'browser execution failed').slice(0, 2000),
        });
        await awaitAck(assignmentId);
        stop();
        return;
      }
      send({
        type: 'task_complete',
        assignmentId,
        attemptNumber,
        result: { ok: true, ...outcome.summary },
        artifacts: outcome.artifacts ?? [],
      });
      await awaitAck(assignmentId);
      stop();
      return;
    }

    if (!instruction || typeof instruction.command !== 'string' || instruction.command.length === 0) {
      sendProgress(send, assignmentId, attemptNumber, { step: 'refused' });
      send({
        type: 'task_fail',
        assignmentId,
        attemptNumber,
        errorCode: 'no_local_instruction',
        error: 'This phase executes explicit local instructions only; the task carried none (autonomous goal execution arrives in a later phase)',
      });
      await awaitAck(assignmentId);
      stop();
      return;
    }
    const workspace = pickWorkspace(config);

    const command = String(instruction.command);
    const shell = String(instruction.shell ?? DEFAULT_SHELL);
    const timeoutMs = Number.isFinite(Number(instruction.timeoutMs)) ? Number(instruction.timeoutMs) : 120_000;
    const cwd = resolveWorkspacePath(workspace!.root, String(instruction.path ?? workspace!.root));

    const gate = gateTerminalInput(command);
    if (!gate.allowed) {
      send({ type: 'task_fail', assignmentId, attemptNumber, errorCode: 'policy_denied', error: gate.reason });
      await awaitAck(assignmentId);
      stop();
      return;
    }
    const decision = classifyCommand(command);
    if (!decision.allowed) {
      send({ type: 'task_fail', assignmentId, attemptNumber, errorCode: 'policy_denied', error: decision.reason });
      await awaitAck(assignmentId);
      stop();
      return;
    }
    if (!cwd.ok) {
      send({ type: 'task_fail', assignmentId, attemptNumber, errorCode: 'path_outside_grant', error: cwd.reason });
      await awaitAck(assignmentId);
      stop();
      return;
    }

    sendProgress(send, assignmentId, attemptNumber, { step: 'running', command, cwd: cwd.abs, shell });

    const result = await runCommandOnce(shell, command, cwd.abs, { timeoutMs, maxBytes: 512 * 1024 });
    if (!running.has(assignmentId)) return;

    sendProgress(send, assignmentId, attemptNumber, {
      step: 'finished',
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outputByteLength: result.output.length,
    });

    if (!result.ok || result.timedOut) {
      send({
        type: 'task_fail',
        assignmentId,
        attemptNumber,
        errorCode: result.timedOut ? 'local_timeout' : 'local_command_failed',
        error: result.error ?? (result.timedOut ? 'command timed out' : 'command exited non-zero'),
      });
      await awaitAck(assignmentId);
      stop();
      return;
    }

    const artifacts = collectArtifacts(instruction, cwd.abs);
    send({
      type: 'task_complete',
      assignmentId,
      attemptNumber,
      result: {
        ok: true,
        exitCode: result.exitCode,
        shell,
        cwd: cwd.abs,
        command,
        outputByteLength: result.output.length,
        summary: result.output.slice(0, 2000),
      },
      artifacts,
    });
    await awaitAck(assignmentId);
    stop();
  } catch (err) {
    send({
      type: 'task_fail',
      assignmentId,
      attemptNumber,
      errorCode: 'local_executor_error',
      error: err instanceof Error ? err.message : 'unexpected executor failure',
    });
    await awaitAck(assignmentId).catch(() => undefined);
    stop();
  }
}

function pickWorkspace(config: AgentConfig): WorkspaceGrant | undefined {
  return (config.workspaces ?? []).find((w) => (w.capabilities ?? []).includes('terminal_exec'));
}

/** Union of capabilities across the device's browser grants. */
function browserGrantedCaps(config: AgentConfig): string[] {
  const caps = new Set<string>();
  for (const g of config.browser ?? []) {
    for (const c of g.capabilities ?? []) caps.add(c);
  }
  return [...caps];
}

/** Infer required browser.* caps straight from the instruction actions. */
function browserCapsFrom(instruction: Record<string, unknown> | null): string[] {
  if (!instruction || instruction.type !== 'browser' || !Array.isArray(instruction.actions)) return [];
  const caps = new Set<string>();
  for (const action of instruction.actions as { op?: unknown }[]) {
    if (action && typeof action.op === 'string') caps.add(ACTION_CAP[action.op] ?? action.op);
  }
  return [...caps].filter((c) => c.startsWith('browser.'));
}

const ACTION_CAP: Readonly<Record<string, string>> = {
  open: 'browser.open',
  navigate: 'browser.navigate',
  back: 'browser.navigate',
  forward: 'browser.navigate',
  reload: 'browser.navigate',
  scroll: 'browser.read',
  read: 'browser.read',
  search: 'browser.read',
  extract: 'browser.read',
  inspect: 'browser.inspect',
  screenshot: 'browser.inspect',
  click: 'browser.click',
  type: 'browser.type',
  select: 'browser.submit',
  submit: 'browser.submit',
  download: 'browser.download',
  upload: 'browser.upload',
};

function sendProgress(send: (msg: Record<string, unknown>) => void, assignmentId: string, attemptNumber: number, progress: Record<string, unknown>): void {
  send({ type: 'task_progress', assignmentId, attemptNumber, progress });
}

/** Real artifact references for declared output paths (never invented). */
function collectArtifacts(instruction: Record<string, unknown>, cwd: string): Record<string, unknown>[] {
  const outputs = Array.isArray(instruction.outputs) ? (instruction.outputs as string[]) : [];
  const artifacts: Record<string, unknown>[] = [];
  for (const rel of outputs) {
    if (typeof rel !== 'string' || !rel) continue;
    const abs = join(cwd, rel);
    if (!existsSync(abs)) continue;
    const content = readFileSync(abs);
    artifacts.push({
      kind: 'file',
      path: rel,
      absPath: abs,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return artifacts;
}