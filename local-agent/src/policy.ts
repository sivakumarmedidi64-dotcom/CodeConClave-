/**
 * CodeConClave Local Agent — deny-by-default policy (Section 6.4).
 * Immutable baseline deny list: protected paths (secrets), traversal/symlink
 * escapes, dangerous commands. Capability model: every operation requires an
 * explicit grant (workspace root + capability). Policy is deterministic,
 * never an LLM decision.
 */
import { realpathSync } from 'node:fs';
import { resolve, sep, relative } from 'node:path';

export type Risk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Decision {
  allowed: boolean;
  risk: Risk;
  reason: string;
}

/** Default-protected path patterns — never bypassable by a workspace grant. */
const PROTECTED_PATTERNS: RegExp[] = [
  /(^|\/|\\|\\)\.env($|\.|$)/i,
  /(^|\/|\\|\\)\.env\.[A-Z0-9_.-]+$/i,
  /(^|\/|\\|\\)\.ssh(\/|\\)?/,
  /(^|\/|\\|\\)(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/|\\|\\)\.aws(\/|\\)?/,
  /(^|\/|\\|\\)\.azure(\/|\\)?/,
  /(^|\/|\\|\\)\.gcloud(\/|\\)?/,
  /(^|\/|\\|\\)\.config\/gcloud(\/|\\)?/,
  /(^|\/|\\|\\)(credentials|secrets?|tokens?|service-account)\.(json|txt|yaml|yml|ini)$/i,
  // Backend upload-policy basenames, mirrored so the desktop gate matches.
  /(^|\/|\\|\\)\.(netrc|htpasswd|pgpass|npmrc|pypirc)$/,
  // Orchestrator / container credentials.
  /(^|\/|\\|\\)\.kube(\/|\\)?/,
  /(^|\/|\\|\\)\.docker(\/|\\)?config\.json$/,
  // Browser credential stores (Chromium + Firefox profiles).
  /(^|\/|\\|\\)(Login Data|Cookies|Local State|logins\.json|key4\.db|cert9\.db)$/,
  // OS keychains / PGP + shell histories.
  /(^|\/|\\|\\)Library(\/|\\)Keychains(\/|\\)?/,
  /(^|\/|\\|\\)\.gnupg(\/|\\)?/,
  /(^|\/|\\|\\)\.(bash_history|zsh_history|ps_history|mysql_history|psql_history|irb_history)$/,
  /(^|\/|\\|\\)\.codeconclave(\/|\\)?/,
  /(^|\/|\\|\\)\.git(\/|\\)?/,
];

/** Dangerous command prefixes (blocked unless explicitly overridden). */
const DANGEROUS_COMMANDS: RegExp[] = [
  /^\s*rm\s+(-[a-z]*r[a-z]*\s+)*\/(\s|$)/i,
  /^\s*rm\s+(-[a-z]*r[a-z]*\s+)*(-f\s+)+--?no-preserve-root/i,
  /^\s*dd\s+/,
  /^\s*mkfs\s+/,
  /^\s*(mkfs\.|fdisk|parted)\s+/,
  /^\s*shutdown|^\s*reboot|^\s*poweroff/i,
  /^\s*chmod\s+(-[a-z]*R[a-z]*\s+)?(777|a\+w)\s+\/(\s|$)/i,
  /^\s*>\s*\/dev\/(sda|sdb|sdc)/,
  /:\(\)\{.*\};/,
  /^\s*curl\s+.*\|\s*(ba)?sh\s*$/i,
  /^\s*wget\s+.*-O\s*-\s*\|\s*(ba)?sh\s*$/i,
  /^\s*sudo\s+(rm|dd|mkfs|shutdown|reboot|chmod)/i,
];

export function isProtectedPath(absPath: string): boolean {
  const norm = absPath.replace(/\//g, sep);
  return PROTECTED_PATTERNS.some((re) => re.test(norm));
}

/** Commands considered safe-by-default for terminal use (first token). */
const SAFE_COMMAND_PREFIX = [
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'python', 'python3', 'pip', 'pip3',
  'tsc', 'vite', 'vitest', 'jest', 'pytest', 'go', 'cargo', 'git', 'ls', 'cat',
  'grep', 'rg', 'sed', 'awk', 'head', 'tail', 'wc', 'find', 'echo', 'printf',
  'bash', 'zsh', 'sh', 'fish', 'powershell', 'pwsh', 'cmd', 'ps', 'top', 'htop',
  'du', 'df', 'tree', 'mkdir', 'touch', 'cp', 'mv', 'diff', 'tar', 'unzip',
  'npm-run-all', 'eslint', 'prettier', 'tsx', 'curl', 'wget', 'kubectl', 'docker',
];

/**
 * Shell builtins and common PowerShell cmdlets: interpreted by the already-
 * running interactive shell itself (no external process spawn), so they are
 * safe to pass through the terminal input gate.
 */
const BUILTIN_OR_CMDLET = [
  'cd', 'pwd', 'ls', 'dir', 'echo', 'exit', 'clear', 'cls', 'pushd', 'popd',
  'set', 'unset', 'export', 'source', 'alias', 'unalias', 'history', 'help',
  'env', 'type', 'which', 'where', 'kill', 'jobs', 'fg', 'bg', 'sleep', 'date',
  'test', 'true', 'false', 'read', 'local', 'shift', 'return', 'trap', 'umask',
  'ulimit', 'hash', 'break', 'continue', 'printf', 'pwd',
  'Write-Output', 'Write-Host', 'Write-Error', 'Write-Warning', 'Write-Verbose',
  'Get-Location', 'Set-Location', 'Get-ChildItem', 'Get-Content', 'Set-Content',
  'Add-Content', 'Clear-Content', 'Copy-Item', 'Move-Item', 'Remove-Item',
  'New-Item', 'Rename-Item', 'Get-Item', 'Get-ItemProperty', 'Set-ItemProperty',
  'Test-Path', 'Resolve-Path', 'Join-Path', 'Split-Path', 'Get-Command',
  'Get-Process', 'Stop-Process', 'Start-Process', 'Start-Sleep', 'Get-Date',
  'Get-Variable', 'Set-Variable', 'Clear-Variable', 'Get-History', 'Clear-History',
  'Get-Alias', 'Set-Alias', 'Get-Help', 'Select-String', 'Select-Object',
  'Where-Object', 'ForEach-Object', 'Sort-Object', 'Measure-Object',
  'Group-Object', 'Format-Table', 'Format-List', 'Out-String', 'Out-File',
  'ConvertTo-Json', 'ConvertFrom-Json', 'Compare-Object', 'New-Object',
  'Read-Host', 'Clear-Host', 'Invoke-WebRequest', 'Invoke-RestMethod',
  'Get-Service', 'Get-CimInstance', '$PSVersionTable', '$?', '$PID',
];

/**
 * Shells and interpreters that execute a *nested command string* taken from a
 * later argument. Classifying only the first token would let
 * `bash -c "rm -rf /"` through as a safe `bash`, so whenever one of these is
 * the effective command and a nested-command flag is present, the nested line
 * is gated recursively instead of being trusted.
 */
const NESTED_COMMAND_SHELLS = new Set([
  'bash', 'zsh', 'sh', 'dash', 'ksh', 'csh', 'tcsh', 'fish',
  'powershell', 'pwsh', 'cmd',
  'node', 'python', 'python3', 'perl', 'ruby', 'php',
]);

/** Flags whose following argument is itself a command string (longest first). */
const NESTED_COMMAND_FLAG =
  /(?:^|\s)(-encodedcommand|-command|-eval|--command|--eval|-c|-e|\/c|\/k)(?=\s|$|["'])/i;

/** Nesting depth cap — guards against pathological `bash -c "bash -c …"`. */
const MAX_NESTED_DEPTH = 5;

const RISK_ORDER: Record<Risk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

function maxRisk(a: Risk, b: Risk): Risk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/** Strip one *matching* pair of surrounding quotes, if present. */
function unquote(value: string): string {
  const t = value.trim();
  if (t.length >= 2) {
    const [a, b] = [t[0], t[t.length - 1]];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return t.slice(1, -1);
  }
  return t;
}

/**
 * Returns the command string handed to a nested-shell flag (`bash -c …`,
 * `cmd /c …`, `node -e …`), or `null` when the command is not a nested-shell
 * invocation. `line` must already have any `sudo` prefix removed, so the flag
 * search cannot be confused by it.
 */
function extractNestedCommand(first: string, line: string): string | null {
  const rest = line.slice(first.length);
  const match = NESTED_COMMAND_FLAG.exec(rest);
  if (!match) return null;
  const inner = unquote(rest.slice(match.index + match[0].length));
  return inner ? inner : null;
}

/**
 * Gate a nested command extracted from a shell/interpreter invocation.
 * Returns `null` when there is no nested command to gate.
 */
function gateNested(
  first: string,
  effective: string,
  base: string,
  depth: number,
  evaluate: (line: string, depth: number) => Decision,
): Decision | null {
  if (!NESTED_COMMAND_SHELLS.has(base)) return null;
  const nested = extractNestedCommand(first, effective);
  if (nested === null) return null;
  if (depth + 1 > MAX_NESTED_DEPTH) {
    return { allowed: false, risk: 'MEDIUM', reason: 'nested command depth limit exceeded' };
  }
  const inner = evaluate(nested, depth + 1);
  if (!inner.allowed) {
    return { allowed: false, risk: inner.risk, reason: `${base}: ${inner.reason}` };
  }
  return {
    allowed: true,
    risk: maxRisk('LOW', inner.risk),
    reason: `nested command via ${base}: ${inner.reason}`,
  };
}

export function classifyCommand(command: string, depth = 0): Decision {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: true, risk: 'LOW', reason: 'empty command' };
  if (DANGEROUS_COMMANDS.some((re) => re.test(trimmed))) {
    return { allowed: false, risk: 'CRITICAL', reason: 'dangerous command blocked by immutable policy' };
  }
  const isSudo = /^sudo\s+/.test(trimmed);
  const effective = isSudo ? trimmed.replace(/^sudo\s+/, '') : trimmed;
  const first = effective.split(/\s+/)[0] ?? '';
  const base = first.split(/[/\\]/).pop() ?? first;
  const nested = gateNested(first, effective, base, depth, (line, nextDepth) =>
    classifyCommand(line, nextDepth),
  );
  if (nested) {
    return isSudo && nested.allowed ? { ...nested, risk: 'HIGH' } : nested;
  }
  if (SAFE_COMMAND_PREFIX.includes(base)) {
    if (isSudo) return { allowed: true, risk: 'HIGH', reason: 'sudo requires explicit approval' };
    return { allowed: true, risk: 'LOW', reason: 'allowlisted command' };
  }
  return { allowed: false, risk: isSudo ? 'HIGH' : 'MEDIUM', reason: `command not allowlisted: ${base}` };
}

/**
 * Phase 4B: deterministic gate for interactive terminal input. Every line
 * typed into a session passes through the policy engine before reaching the
 * real process: immutable dangerous commands (CRITICAL) and privilege
 * escalation (HIGH) are always denied — there is no approval channel inside an
 * interactive terminal, so they are refused outright rather than bypassed.
 * Allowlisted child commands and shell builtins/cmdlets pass; unknown commands
 * are denied by default.
 */
export function gateTerminalInput(line: string, depth = 0): Decision {
  const trimmed = line.trim();
  if (!trimmed) return { allowed: true, risk: 'LOW', reason: 'empty input' };
  if (DANGEROUS_COMMANDS.some((re) => re.test(trimmed))) {
    return { allowed: false, risk: 'CRITICAL', reason: 'dangerous command blocked by immutable policy' };
  }
  if (/^(sudo|su)\s/.test(trimmed)) {
    return { allowed: false, risk: 'HIGH', reason: 'privilege escalation requires explicit approval (unavailable in an interactive terminal)' };
  }
  const first = trimmed.split(/\s+/)[0] ?? '';
  const base = first.split(/[/\\]/).pop() ?? first;
  const nested = gateNested(first, trimmed, base, depth, (inner, nextDepth) =>
    gateTerminalInput(inner, nextDepth),
  );
  if (nested) return nested;
  if (SAFE_COMMAND_PREFIX.includes(base) || BUILTIN_OR_CMDLET.includes(base)) {
    return { allowed: true, risk: 'LOW', reason: 'allowlisted command or shell builtin' };
  }
  return { allowed: false, risk: 'MEDIUM', reason: `command not allowlisted: ${base}` };
}

/**
 * Resolve a request path against a workspace root, defending against
 * traversal and symlink escapes. Returns the real absolute path when safe.
 */
export function resolveWorkspacePath(root: string, requested: string): { ok: true; abs: string } | { ok: false; reason: string } {
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { ok: false, reason: 'workspace root does not exist' };
  }
  const abs = resolve(rootReal, requested);
  const rel = relative(rootReal, abs);
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
    return { ok: false, reason: 'path escapes the workspace root' };
  }
  try {
    const real = realpathSync(abs);
    if (real !== abs && !isInside(rootReal, real)) {
      return { ok: false, reason: 'symlink escapes the workspace root' };
    }
  } catch {
    // target does not exist yet (e.g. creating a file) — parent chain is checked
    const parent = abs.split(sep).slice(0, -1).join(sep);
    try {
      const parentReal = realpathSync(parent || rootReal);
      if (!isInside(rootReal, parentReal)) return { ok: false, reason: 'symlink escape in parent chain' };
    } catch {
      return { ok: false, reason: 'parent path unavailable' };
    }
  }
  if (isProtectedPath(abs)) {
    return { ok: false, reason: 'path matches deny-by-default protected patterns' };
  }
  return { ok: true, abs };
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`));
}
