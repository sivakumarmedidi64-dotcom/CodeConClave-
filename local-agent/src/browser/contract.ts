/**
 * CodeConClave Local Agent — browser action contract (agent side).
 *
 * The server validates an instruction before storing it, but the agent RE-CHECKS
 * every action at execution time, in its own process, against its own grants.
 * A mis-issued or tampered instruction is denied before it touches the browser:
 *   - each op requires exactly one capability within a granted browser scope;
 *   - navigation destinations must match a granted origin (private/internal
 *     targets are never reachable through a public `*` grant);
 *   - credentials/payment surfaces are readable but never interacted with;
 *   - files (upload/download) stay inside a granted workspace and never touch
 *     protected paths; downloads land in the per-assignment download directory.
 * Mode 2 (controlling the user's existing authenticated browser tabs) is out of
 * scope and denied explicitly.
 */
import { join, resolve } from 'node:path';
import type { AgentConfig, BrowserGrant, WorkspaceGrant } from '../config.js';
import { resolveWorkspacePath, isProtectedPath } from '../policy.js';

export const KNOWN_BROWSER_CAPABILITIES: ReadonlySet<string> = new Set([
  'browser.open',
  'browser.navigate',
  'browser.read',
  'browser.inspect',
  'browser.click',
  'browser.type',
  'browser.submit',
  'browser.download',
  'browser.upload',
]);

export const OP_TO_CAPABILITY: Readonly<Record<string, string>> = {
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

/** Ops the executor may re-run on a retryable failure (never blindly replayed). */
export const RETRYABLE_OPS: ReadonlySet<string> = new Set([
  'open',
  'navigate',
  'reload',
  'read',
  'search',
  'extract',
  'scroll',
  'screenshot',
]);

const CONSEQUENTIAL_OPS: ReadonlySet<string> = new Set(['click', 'type', 'select', 'submit', 'upload', 'download']);

const SENSITIVE_HOST_PATTERNS: RegExp[] = [
  /(^|\.)(login|signin|sign-in|auth|accounts?|account|checkout|payments?|billing)(\.|$)/i,
  /(^|\.)(paypal|stripe|adyen|braintree)\./i,
];

const BLOCKED_HOST_PATTERNS: RegExp[] = [/^([\w-]+\.)*aws\.amazon\.com$/i, /^([\w-]+\.)*amazonaws\.com$/i, /^([\w-]+\.)*azure\.com$/i, /^([\w-]+\.)*googleapis\.com$/i];

export function browserGrants(config: AgentConfig): BrowserGrant[] {
  return (config.browser ?? []).filter((g) => (g.capabilities ?? []).every((c) => KNOWN_BROWSER_CAPABILITIES.has(c)) && Array.isArray(g.allowedOrigins));
}

/** Capabilities the device honestly claims at register time. */
export function advertisedBrowserCapabilities(config: AgentConfig): string[] {
  const caps = new Set<string>();
  for (const g of browserGrants(config)) {
    for (const c of g.capabilities) caps.add(c);
  }
  return [...caps];
}

// ---------------------------------------------------------------- destinations

function effectivePort(url: URL): string {
  const p = url.port;
  if (p) return p;
  return url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '';
}

export function isPrivateHost(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/\.$/, '');
  h = h.startsWith('[') ? h.slice(1, -1) : h;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (/\.(test|internal|local|example|invalid)$/.test(h) || h === 'test' || h === 'internal') return true;
  if (/^127\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  if (h.includes(':')) {
    if (/^f[cd]/.test(h)) return true;
    if (/^fe[89abcd]/.test(h)) return true;
  }
  return false;
}

export function allowedOriginMatches(origin: string, url: URL): boolean {
  const o = origin.trim();
  if (o === '*') return !isPrivateHost(url.hostname) && !BLOCKED_HOST_PATTERNS.some((re) => re.test(url.hostname));
  if (o.endsWith('/*')) return bandMatch(o.slice(0, -2), url);
  if (/:\*$/.test(o)) {
    try {
      const base = new URL(o.slice(0, -2));
      return url.protocol === base.protocol && url.hostname.toLowerCase() === base.hostname.toLowerCase();
    } catch {
      return false;
    }
  }
  return bandMatch(o, url);
}

function bandMatch(origin: string, url: URL): boolean {
  try {
    const allowed = new URL(origin);
    return (
      url.protocol === allowed.protocol &&
      url.hostname.toLowerCase() === allowed.hostname.toLowerCase() &&
      effectivePort(url) === effectivePort(allowed)
    );
  } catch {
    return false;
  }
}

export function sensitiveDestination(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  return SENSITIVE_HOST_PATTERNS.some((re) => re.test(host));
}

export type ScopeDecision = { ok: true } | { ok: false; reason: string; errorCode: string };

/**
 * The single gate every action passes right before touching the browser.
 * Returns the granted browser grant + resolved filesystem inputs on success.
 */
export function assertBrowserAction(
  action: Record<string, unknown>,
  config: AgentConfig,
): { ok: true; grant: BrowserGrant; absUploadPath?: string; downloadDir: string } | { ok: false; reason: string; errorCode: string } {
  const op = typeof action.op === 'string' ? action.op : '';
  if (!op) return deny('missing_op', 'browser_malformed_action');
  if (!OP_TO_CAPABILITY[op]) return deny(`unsupported_op_${op}`, 'browser_unsupported_op');
  const grants = browserGrants(config);
  if (grants.length === 0) return deny('no browser grant enabled (run `codeconclave-agent browser enable`)', 'browser_not_granted');
  const requiredCap = OP_TO_CAPABILITY[op]!;
  const grant = grants.find((g) => (g.capabilities ?? []).includes(requiredCap));
  if (!grant) return deny(`op ${op} requires capability ${requiredCap} which is not granted`, 'browser_capability_not_granted');
  const allowedOrigins = (grant.allowedOrigins ?? []).filter((o): o is string => typeof o === 'string');
  const workspace = pickWorkspace(config);
  if (!workspace) return deny('upload/download require a granted workspace', 'browser_no_workspace');

  if (op === 'open' || op === 'navigate') {
    const url = typeof action.url === 'string' && action.url.length > 0 ? action.url : '';
    const dest = validateDestination(url, allowedOrigins);
    if (!dest.ok) return dest;
    if (CONSEQUENTIAL_OPS.has(op) && sensitiveDestination(dest.url)) return deny('destination is an auth/payment surface', 'browser_sensitive_destination');
    return { ok: true, grant, downloadDir: downloadDirFor(workspace) };
  }
  if (op === 'download') {
    if (action.url !== undefined) {
      const url = typeof action.url === 'string' && action.url.length > 0 ? action.url : '';
      const dest = validateDestination(url, allowedOrigins);
      if (!dest.ok) return dest;
    }
    return { ok: true, grant, downloadDir: downloadDirFor(workspace) };
  }
  if (op === 'upload') {
    const path = typeof action.path === 'string' && action.path.length > 0 ? action.path : '';
    const raw = resolve(workspace.root, path);
    if (isProtectedPath(raw)) return deny('upload source is a protected path', 'browser_upload_protected');
    const resolved = resolveWorkspacePath(workspace.root, path);
    if (!resolved.ok) return deny('upload source must be inside a granted workspace', 'browser_upload_out_of_scope');
    return { ok: true, grant, absUploadPath: resolved.abs, downloadDir: downloadDirFor(workspace) };
  }
  if (CONSEQUENTIAL_OPS.has(op)) {
    // Interaction ops guard the CURRENT page: reading a login page is fine,
    // filling or submitting could bypass a credential gate.
    const current = currentPageUrl();
    if (current && sensitiveDestination(current)) return deny('current page is an auth/payment surface', 'browser_sensitive_destination');
  }
  return { ok: true, grant, downloadDir: downloadDirFor(workspace) };
}

function validateDestination(url: string, allowedOrigins: string[]): { ok: true; url: URL } | { ok: false; reason: string; errorCode: string } {
  if (!url) return deny('missing url', 'browser_malformed_action');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny('malformed url', 'browser_bad_url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return deny('only http(s) destinations are allowed', 'browser_bad_url');
  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(parsed.hostname))) return deny('destination host is blocked', 'browser_blocked_host');
  if (!allowedOrigins.some((o) => allowedOriginMatches(o, parsed))) {
    return deny('destination is outside every granted origin scope', 'browser_destination_out_of_scope');
  }
  return { ok: true, url: parsed };
}

let currentPageUrl: () => URL | null = () => null;
/** The controller publishes the current page URL so interaction ops can gate on it. */
export function setCurrentPageUrlProvider(fn: () => URL | null): void {
  currentPageUrl = fn;
}

function deny(reason: string, errorCode: string): { ok: false; reason: string; errorCode: string } {
  return { ok: false, reason, errorCode };
}

function pickWorkspace(config: AgentConfig): WorkspaceGrant | undefined {
  const ws = (config.workspaces ?? []).filter((w) => (w.capabilities ?? []).includes('terminal_exec'));
  return ws[0] ?? (config.workspaces ?? [])[0];
}

/** Downloads always land under the workspace, in an assignment-subdir dir. */
export function downloadDirFor(workspace: WorkspaceGrant, assignmentId = 'session'): string {
  return join(workspace.root, 'browser-downloads', sanitize(assignmentId));
}

function sanitize(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
  return clean || 'assignment';
}

export function resolveDownloadPath(downloadDir: string, filename: string): string {
  const sane = filename.replace(/[\\/]/g, '_').replace(/^\.+/, '').replace(/[:*?"<>|]/g, '_').slice(0, 160) || 'download.bin';
  return resolve(downloadDir, sane);
}