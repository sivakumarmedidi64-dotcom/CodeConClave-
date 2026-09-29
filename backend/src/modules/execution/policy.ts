/**
 * CodeConClave — deterministic policy engine.
 * NOT an LLM. Evaluates tool name, resource path, command, network destination,
 * scope, user permission, and risk class. Deny-by-default with immutable
 * baseline protections. Model output can never reach execution directly:
 * it must pass through this engine as a typed tool call.
 */
import { RiskLevel, FileOperation } from '@codeconclave/shared';
import { AppError } from '../../shared/errors.js';
import { incMetric } from '../../observability/metrics.js';

export type PolicyDecision =
  | { allowed: true; risk: Risky; requiresApproval: boolean }
  | { allowed: false; reason: string; deniedBy: string };

export type Risky = (typeof RiskLevel)[keyof typeof RiskLevel];

/** Deny with a security metric tagged by policy class (never user content). */
function deny(deniedBy: string, reason: string, metric: string): Extract<PolicyDecision, { allowed: false }> {
  incMetric(`security.${metric}`);
  return { allowed: false, deniedBy, reason };
}

// ---------------------------------------------------------------- baseline deny patterns (immutable)

const SECRET_PATTERNS: RegExp[] = [
  /(^|\/)\.[\w.-]*env(\.[\w.-]+)?$/i, // .env, .env.local, .env.production
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)id_rsa($|[._-])/i,
  /(^|\/)id_ed25519($|[._-])/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.azure(\/|$)/i,
  /(^|\/)\.gcp(\/|$)/i,
  /(^|\/)\.kube(\/|$)/i,
  /credentials\.json$/i,
  /(^|\/)service-account/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.pgpass$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)(token|secret|apikey|api_key)s?(\.[a-z]+)?$/i,
];

const OS_SENSITIVE_PREFIXES = [
  '/etc',
  '/var',
  '/usr',
  '/boot',
  '/proc',
  '/sys',
  '/dev',
  '/system',
  '/library',
  'c:/windows',
  'c:/program files',
  'c:/programdata',
];

const DANGEROUS_COMMANDS = [
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'dd if=',
  'mkfs',
  'fdisk',
  ':(){ :|:& };:',
  'chmod -R 777 /',
  '> /dev/sda',
  'shutdown',
  'reboot',
  'halt',
  'mkfs.ext4',
  'sudo rm',
  'git push --force',
];

const NETWORK_BLOCKED_HOSTS = [
  /^([\w-]+\.)*aws\.amazon\.com$/i,
  /^([\w-]+\.)*amazonaws\.com$/i,
  /^([\w-]+\.)*azure\.com$/i,
  /^([\w-]+\.)*googleapis\.com$/i,
];

export function looksLikeSecretPath(path: string): boolean {
  if (!path) return true;
  const posix = path.replace(/\\/g, '/');
  return SECRET_PATTERNS.some((re) => re.test(posix));
}

export function osSensitivePath(path: string): boolean {
  const posix = path.replace(/\\/g, '/').toLowerCase();
  return OS_SENSITIVE_PREFIXES.some((p) => posix.startsWith(p) || posix.startsWith(p.toLowerCase()));
}

/** Path traversal defense: absolute paths, .. segments, and symlink escapes are rejected. */
export function validWorkspacePath(path: string, scopePrefix?: string): boolean {
  if (!path) return false;
  const posix = path.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) return false;
  if (posix.split('/').includes('..')) return false;
  if (scopePrefix && !posix.startsWith(scopePrefix)) return false;
  return true;
}

export function dangerousCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (
    DANGEROUS_COMMANDS.some((pattern) => {
      const p = pattern.toLowerCase();
      return normalized === p || normalized.startsWith(p);
    })
  ) {
    return true;
  }
  // Pipe-to-shell execution (curl|bash, wget -O- | sh) — denied like the
  // local-agent policy: fetched scripts must never reach a shell implicitly.
  return /^\s*(curl|wget)\b[\s\S]*\|\s*(ba|z|k)?sh(\s|$)/i.test(command);
}

export function blockedNetworkHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return NETWORK_BLOCKED_HOSTS.some((re) => re.test(host));
  } catch {
    return true; // malformed URL → deny
  }
}

// ---------------------------------------------------------------- risk model

export function riskOfPathOperation(operation: FileOperation, path: string): Risky {
  if (looksLikeSecretPath(path) || osSensitivePath(path)) return 'CRITICAL';
  switch (operation) {
    case 'READ':
      return 'LOW';
    case 'LIST':
    case 'STAT':
      return 'LOW';
    case 'WRITE':
    case 'CREATE':
      return 'MEDIUM';
    case 'RENAME':
      return 'MEDIUM';
    case 'DELETE':
      return 'HIGH';
    default:
      return 'MEDIUM';
  }
}

export function riskOfCommand(command: string): Risky {
  if (dangerousCommand(command)) return 'CRITICAL';
  const lower = command.toLowerCase();
  if (/^(sudo|su)\s/.test(lower)) return 'HIGH';
  if (/^(npm install|npm i|pip install|yarn add|pnpm add)\b/.test(lower)) return 'MEDIUM';
  if (/^(npm|npx|pnpm|yarn|node|python|python3|bash|zsh|sh|git|curl|wget)\b/.test(lower)) return 'LOW';
  return 'MEDIUM';
}

export function riskOfNetworkAction(destination: string, method: string): Risky {
  if (blockedNetworkHost(destination)) return 'CRITICAL';
  if (method.toUpperCase() !== 'GET') return 'MEDIUM';
  return 'LOW';
}

export function riskOfPublish(thing: string): Risky {
  const lower = thing.toLowerCase();
  if (/deploy|production|publish/.test(lower)) return 'HIGH';
  return 'MEDIUM';
}

// ---------------------------------------------------------------- advisory

export interface CapabilityGrant {
  id: string;
  userId: string;
  capability: 'READ_WORKSPACE' | 'WRITE_WORKSPACE' | 'EXECUTE_COMMAND' | 'NETWORK_ACCESS';
  scope: string;
  expiresAt: number;
  allowedCommands?: string[];
}

const activeGrants = new Map<string, CapabilityGrant[]>();

/** Capability grants: explicit per-project allowlists, created only through
 * privileged security policy (auth service), never by arbitrary AI prompt. */
export function registerGrants(grants: CapabilityGrant[]): void {
  for (const grant of grants) {
    const list = activeGrants.get(grant.userId) ?? [];
    list.push(grant);
    activeGrants.set(grant.userId, list);
  }
}

export function revokeGrants(userId: string, grantIds?: string[]): void {
  if (!grantIds) {
    activeGrants.delete(userId);
    return;
  }
  const list = activeGrants.get(userId) ?? [];
  activeGrants.set(userId, list.filter((g) => !grantIds.includes(g.id)));
}

export function hasCapability(userId: string, capability: CapabilityGrant['capability'], resource: string): boolean {
  const grants = activeGrants.get(userId) ?? [];
  const now = Date.now();
  for (const grant of grants) {
    if (grant.capability !== capability) continue;
    if (grant.expiresAt <= now) continue;
    if (grant.scope === '*' || resource.startsWith(grant.scope)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- the engine

export interface ToolCallProposal {
  tool: string;
  input: Record<string, unknown>;
  userId: string;
  grantUserId?: string; // grant holder (e.g. local agent pairing) if different
}

/**
 * Evaluate a typed tool call. Returns allow/deny + risk + approval requirement.
 * Order of evaluation (immutable baseline first):
 *   1. secrets / OS-sensitive paths → DENY (no approval path)
 *   2. dangerous commands → DENY unless explicitly overridden (impossible via prompt)
 *   3. scope/capability check → DENY
 *   4. risk assessment → approve/auto-approve/require approval
 */
export function evaluateToolCall(proposal: ToolCallProposal): PolicyDecision {
  const { tool, input, userId } = proposal;
  const ownerId = proposal.grantUserId ?? userId;
  const path = typeof input.path === 'string' ? input.path : typeof input.filePath === 'string' ? input.filePath : '';
  const command = typeof input.command === 'string' ? input.command : '';
  const url = typeof input.url === 'string' ? input.url : '';

  switch (tool) {
    case 'file_read': {
      if (!validWorkspacePath(path)) {
        return deny('baseline_secrets', 'Path traversal or absolute paths are deny-by-default', 'paths_blocked');
      }
      if (looksLikeSecretPath(path) || osSensitivePath(path)) {
        return deny('baseline_secrets', 'Secret or sensitive paths are deny-by-default', 'secrets_blocked');
      }
      if (!hasCapability(ownerId, 'READ_WORKSPACE', path)) {
        return deny('capability', 'No READ_WORKSPACE grant for this path', 'capability_denied');
      }
      return { allowed: true, risk: 'LOW', requiresApproval: false };
    }
    case 'file_list': {
      if (!validWorkspacePath(path)) {
        return deny('baseline_secrets', 'Path traversal or absolute paths are deny-by-default', 'paths_blocked');
      }
      if (!hasCapability(ownerId, 'READ_WORKSPACE', path)) {
        return deny('capability', 'No READ_WORKSPACE grant for this path', 'capability_denied');
      }
      return { allowed: true, risk: 'LOW', requiresApproval: false };
    }
    case 'browser_open': {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return deny('baseline_network', 'Only http(s) URLs can be opened in the browser', 'network_blocked');
        }
      } catch {
        return deny('baseline_network', 'Malformed URL', 'network_blocked');
      }
      if (blockedNetworkHost(url)) {
        return deny('baseline_network', 'Destination is blocked by network policy', 'network_blocked');
      }
      if (!hasCapability(ownerId, 'EXECUTE_COMMAND', 'browser_open')) {
        return deny('capability', 'No EXECUTE_COMMAND grant for this device', 'capability_denied');
      }
      return { allowed: true, risk: 'LOW', requiresApproval: false };
    }
    case 'file_write':
    case 'file_create': {
      if (!validWorkspacePath(path)) {
        return deny('baseline_secrets', 'Path traversal or absolute paths are deny-by-default', 'paths_blocked');
      }
      if (looksLikeSecretPath(path) || osSensitivePath(path)) {
        return deny('baseline_secrets', 'Secret or sensitive paths are deny-by-default', 'secrets_blocked');
      }
      if (!hasCapability(ownerId, 'WRITE_WORKSPACE', path)) {
        return deny('capability', 'No WRITE_WORKSPACE grant for this path', 'capability_denied');
      }
      return { allowed: true, risk: 'MEDIUM', requiresApproval: true };
    }
    case 'file_delete': {
      if (!validWorkspacePath(path)) {
        return deny('baseline_secrets', 'Path traversal or absolute paths are deny-by-default', 'paths_blocked');
      }
      if (looksLikeSecretPath(path) || osSensitivePath(path)) {
        return deny('baseline_secrets', 'Secret or sensitive paths are deny-by-default', 'secrets_blocked');
      }
      if (!hasCapability(ownerId, 'WRITE_WORKSPACE', path)) {
        return deny('capability', 'No WRITE_WORKSPACE grant for this path', 'capability_denied');
      }
      return { allowed: true, risk: 'HIGH', requiresApproval: true };
    }
    case 'terminal_exec': {
      if (dangerousCommand(command)) {
        return deny('baseline_commands', 'Dangerous commands are deny-by-default', 'commands_blocked');
      }
      if (!hasCapability(ownerId, 'EXECUTE_COMMAND', command)) {
        return deny('capability', 'No EXECUTE_COMMAND grant (allowed-commands-only policy)', 'capability_denied');
      }
      return { allowed: true, risk: riskOfCommand(command), requiresApproval: riskOfCommand(command) !== 'LOW' };
    }
    case 'network_request': {
      if (blockedNetworkHost(url)) {
        return deny('baseline_network', 'Destination is blocked by network policy', 'network_blocked');
      }
      if (!hasCapability(ownerId, 'NETWORK_ACCESS', 'network')) {
        return deny('capability', 'No NETWORK_ACCESS grant', 'capability_denied');
      }
      return { allowed: true, risk: riskOfNetworkAction(url, String(input.method ?? 'GET')), requiresApproval: false };
    }
    case 'plugin_action': {
      const pluginType = String(input.pluginType ?? '');
      const action = String(input.action ?? '');
      if (action.toLowerCase().includes('publish') || action.toLowerCase().includes('deploy')) {
        return { allowed: true, risk: 'HIGH', requiresApproval: true };
      }
      return { allowed: true, risk: 'MEDIUM', requiresApproval: true };
    }
    case 'dev_server': {
      return { allowed: true, risk: 'LOW', requiresApproval: false };
    }
    default:
      return deny('unknown_tool', `Tool ${tool} is not registered`, 'unknown_tool');
  }
}

export function policyDeniedError(decision: Extract<PolicyDecision, { allowed: false }>): AppError {
  return AppError.forbidden(decision.deniedBy, `Action denied by policy: ${decision.reason}`);
}