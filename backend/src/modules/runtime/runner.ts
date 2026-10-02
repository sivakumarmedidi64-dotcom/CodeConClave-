/**
 * CodeConClave — PKG-19 runtime — sandbox runner factory (F90 anchor, reuse).
 * Wraps the existing PolicySandboxExecutor as the default RuntimeRunner. The
 * executor enforces deny-by-default allow-listing, no-shell, hard timeout with
 * SIGTERM->SIGKILL escalation, and a bounded output cap. On deployments where
 * the sandbox has not allow-listed any command, all calls fail closed (BLOCKED).
 */
import { PolicySandboxExecutor } from '../../os/sandbox.js';
import { AppError } from '../../shared/errors.js';
import type { RuntimeRunner } from './security.js';
import { sandboxAllowedCommands, sandboxTimeoutMs } from './security.js';

/**
 * Build the default runner. `command` is the full command string; the first
 * token becomes the allow-listed executable and the remainder are positional
 * args (never shell-interpolated), matching the sandbox's security model.
 */
export function defaultRunner(): RuntimeRunner {
  const executor = new PolicySandboxExecutor(sandboxAllowedCommands(), sandboxTimeoutMs());
  return {
    async run(input) {
      const [exe = '', ...args] = input.command.trim().split(/\s+/);
      if (!exe) {
        throw AppError.badRequest('runtime_empty_command', 'no command provided');
      }
      const result = await executor.execute({
        allowedCommands: [exe],
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        authorized: input.authorized,
        args: [exe, ...args],
      });
      return result;
    },
  };
}

/** Whether the sandbox allow-list is non-empty (i.e. execution is possible). */
export function executionConfigured(): boolean {
  return sandboxAllowedCommands().length > 0;
}
