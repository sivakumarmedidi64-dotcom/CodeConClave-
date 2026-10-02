/**
 * CodeConClave — PKG-19 runtime — security helpers.
 * Authenticated + project-owned access, deny-by-default command policy,
 * workspace-cwd confinement, and secret redaction of captured output. Mirrors
 * the established app-level isolation (project.owner_id) and the policy
 * sandbox / deterministic policy engine from F90.
 */
import { withTenant, queryOne } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import {
  dangerousCommand,
  evaluateToolCall,
  looksLikeSecretPath,
  policyDeniedError,
} from '../execution/policy.js';
import { env } from '../../config/env.js';

/** Authenticate + authorize project ownership. Throws 404 if the user does not own the project. */
export async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const project = await withTenant<{ id: string } | null>(userId, async (q) =>
    (
      await q.query<{ id: string }>(
        'SELECT id FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL',
        [projectId, userId],
      )
    ).rows[0] ?? null,
  );
  if (!project) throw AppError.notFound('Project');
}

/** A safe, absolute workspace root for a project. Returns null when unconfigured. */
export function projectWorkspaceRoot(projectId: string): string | null {
  if (!env.PREVIEW_PROJECTS_ROOT) return null;
  const base = env.PREVIEW_PROJECTS_ROOT.replace(/[\\/]+$/, '');
  return `${base}${process.platform === 'win32' ? '\\' : '/'}${projectId}`;
}

/** Command prefixes the sandbox is allowed to run (empty = deny-all / block). */
export function sandboxAllowedCommands(): string[] {
  return (env.AIOS_SANDBOX_ALLOWED_COMMANDS || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Current effective sandbox timeout (ms). */
export function sandboxTimeoutMs(): number {
  return env.AIOS_SANDBOX_TIMEOUT_MS && env.AIOS_SANDBOX_TIMEOUT_MS > 0
    ? env.AIOS_SANDBOX_TIMEOUT_MS
    : 30_000;
}

export interface CommandGuardResult {
  allowed: boolean;
  blockedReason?: string;
  requiresApproval: boolean;
}

/** Policy-gate a proposed command for interactive/background runtime use. */
export function evaluateCommand(userId: string, command: string): CommandGuardResult {
  if (!command || command.trim().length === 0) {
    return { allowed: false, blockedReason: 'empty command', requiresApproval: false };
  }
  if (dangerousCommand(command)) {
    return { allowed: false, blockedReason: 'dangerous command is deny-by-default', requiresApproval: false };
  }
  const decision = evaluateToolCall({ tool: 'terminal_exec', input: { command }, userId });
  if (!decision.allowed) {
    return { allowed: false, blockedReason: decision.reason, requiresApproval: false };
  }
  // Interactive/background runs never auto-run anything that requires approval.
  if (decision.requiresApproval) {
    return { allowed: false, blockedReason: 'command requires approval; use the approval flow', requiresApproval: true };
  }
  return { allowed: true, requiresApproval: false };
}

const REDACT_PATTERNS: RegExp[] = [
  /(['"]?)((?:AIOS_|pg|DATABASE|JWT|SESSION|SECRET|API|RAZORPAY|GMAIL|SMTP|NEON|RAILWAY|OPENAI|ANTHROPIC)[A-Z0-9_]*)(['"]?)\s*[:=]\s*['"]?[A-Za-z0-9_\-.\/+=]{4,}['"]?/gi,
  /(postgres(?:ql)?|redis|amqp|https?):\/\/[^\s"'`<>]+/gi,
  /\b(token|secret|api[_-]?key|password|passwd|client_secret|access_key|refresh_token|authorization):[^\s"'`<>]+/gi,
  /\b[A-Za-z0-9_\-]{20,}\b/gi,
];

/** Redact secrets that accidentally appear in captured output. Never returns secrets. */
export function redactOutput(text: string): string {
  return REDACT_PATTERNS.reduce((acc, re) => acc.replace(re, '[REDACTED]'), text);
}

/** Redact sensitive query-string pairs (auth/cookie/api/secret/payment) in URLs. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of ['token', 'access_token', 'api_key', 'apikey', 'key', 'secret', 'password', 'auth', 'cookie', 'payment', 'sig', 'signature']) {
      if (u.searchParams.has(key)) u.searchParams.set(key, '[REDACTED]');
    }
    const out = `${u.protocol}//${u.host}${u.pathname}`;
    return u.search ? `${out}?${u.search}` : out;
  } catch {
    return url.slice(0, 500);
  }
}

/** True when the workspace root is configured and exists on this deployment. */
export async function workspaceUsable(projectId: string): Promise<boolean> {
  const root = projectWorkspaceRoot(projectId);
  if (!root) return false;
  const { stat } = await import('node:fs/promises');
  try {
    await stat(root);
    return true;
  } catch {
    return false;
  }
}

/**
 * Injectable process runner (defaults to the real policy sandbox). Abstracted
 * so tests can inject a deterministic fake without spawning processes.
 */
export interface RuntimeRunner {
  run(input: {
    command: string;
    cwd: string;
    timeoutMs: number;
    authorized: boolean;
  }): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    killed: boolean;
    durationMs: number;
  }>;
}

export function runtimeBlockedErrorDetail(): string {
  return 'Runtime execution is not configured on this deployment (workspace root or sandbox allow-list missing).';
}

export { looksLikeSecretPath };
