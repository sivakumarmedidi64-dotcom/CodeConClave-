/**
 * CodeConClave — P1 browser-control policy (server side).
 *
 * Deterministic, deny-by-default. Validates a browser instruction BEFORE it is
 * stored on a task and BEFORE it is dispatched to a device:
 *   - a strict action→capability map (each op requires exactly one capability);
 *   - every navigation destination is checked against the origin scope, and
 *     private/internal targets are denied unless explicitly granted;
 *   - a strict, tested action shape (never free-form page code or prompts);
 *   - sensitive pages (auth/payment/credential surfaces) are readable but
 *     never interacted with through a general grant;
 *   - a bound on action count (anti-loop) and per-action size caps.
 * The local agent re-checks the same rules at execution time: this module is
 * the contract, both sides enforce it.
 */
import { env } from '../../config/env.js';
import { blockedNetworkHost } from '../execution/policy.js';
import { BrowserActionOp, BrowserCapability } from '@codeconclave/shared';
import type { BrowserActionOp as Op, BrowserCapability as Cap } from '@codeconclave/shared';

export const BROWSER_PERMISSION_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const BROWSER_MAX_ACTIONS = 20;
export const BROWSER_ORIGIN_MAX = 20;
export const BROWSER_MAX_SELECTOR_LENGTH = 512;
export const BROWSER_MAX_URL_LENGTH = 2048;
export const BROWSER_MAX_TEXT_LENGTH = 4096;
export const BROWSER_READ_MAX_BYTES = 64 * 1024;
export const BROWSER_SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;

/** Master gate — default OFF; a disabled capability must never appear enabled. */
export function browserControlEnabled(): boolean {
  return String(env.BROWSER_CONTROL_ENABLED).toLowerCase() === 'true';
}

// ---------------------------------------------------------------- action contracts

/** Strict op → capability mapping. Every op requires exactly one grant. */
export const BROWSER_OP_TO_CAPABILITY: Readonly<Record<Op, Cap>> = {
  [BrowserActionOp.OPEN]: BrowserCapability.OPEN,
  [BrowserActionOp.NAVIGATE]: BrowserCapability.NAVIGATE,
  [BrowserActionOp.BACK]: BrowserCapability.NAVIGATE,
  [BrowserActionOp.FORWARD]: BrowserCapability.NAVIGATE,
  [BrowserActionOp.RELOAD]: BrowserCapability.NAVIGATE,
  [BrowserActionOp.READ]: BrowserCapability.READ,
  [BrowserActionOp.INSPECT]: BrowserCapability.INSPECT,
  [BrowserActionOp.SEARCH]: BrowserCapability.READ,
  [BrowserActionOp.EXTRACT]: BrowserCapability.READ,
  [BrowserActionOp.SCROLL]: BrowserCapability.READ,
  [BrowserActionOp.CLICK]: BrowserCapability.CLICK,
  [BrowserActionOp.TYPE]: BrowserCapability.TYPE,
  [BrowserActionOp.SELECT]: BrowserCapability.SUBMIT,
  [BrowserActionOp.SUBMIT]: BrowserCapability.SUBMIT,
  [BrowserActionOp.SCREENSHOT]: BrowserCapability.INSPECT,
  [BrowserActionOp.DOWNLOAD]: BrowserCapability.DOWNLOAD,
  [BrowserActionOp.UPLOAD]: BrowserCapability.UPLOAD,
};

/** Ops whose outcome, once attempted, must never be blindly replayed on retry. */
export const BROWSER_NON_RETRYABLE_OPS: ReadonlySet<Op> = new Set([
  BrowserActionOp.BACK,
  BrowserActionOp.FORWARD,
  BrowserActionOp.CLICK,
  BrowserActionOp.TYPE,
  BrowserActionOp.SELECT,
  BrowserActionOp.SUBMIT,
  BrowserActionOp.DOWNLOAD,
  BrowserActionOp.UPLOAD,
]);

/** State-changing ops: a general grant never authorizes these on sensitive pages. */
const BROWSER_CONSEQUENTIAL_OPS: ReadonlySet<Op> = new Set([
  BrowserActionOp.CLICK,
  BrowserActionOp.TYPE,
  BrowserActionOp.SELECT,
  BrowserActionOp.SUBMIT,
  BrowserActionOp.UPLOAD,
  BrowserActionOp.DOWNLOAD,
]);

/** Credential / payment / billing surfaces: never interacted with by default. */
const SENSITIVE_HOST_PATTERNS: RegExp[] = [
  /(^|\.)(login|signin|sign-in|auth|accounts?|account|checkout|payments?|billing)(\.|$)/i,
  /(^|\.)(paypal|stripe|adyen|braintree)\./i,
];

export interface BrowserAction {
  op: Op;
  url?: string;
  selector?: string;
  text?: string;
  value?: string;
  query?: string;
  selectors?: string[];
  direction?: 'up' | 'down' | 'top' | 'bottom';
  amount?: number;
  maxBytes?: number;
  path?: string;
}

export interface BrowserInstruction {
  type: 'browser';
  grants: { capabilities: Cap[]; allowedOrigins: string[]; lifetimeMs: number };
  actions: BrowserAction[];
  pinnedDeviceId?: string;
}

export type BrowserParseResult = { ok: true; instruction: BrowserInstruction } | { ok: false; reason: string };

// ---------------------------------------------------------------- destination policy

function effectivePort(url: URL): string {
  const p = url.port;
  if (p) return p;
  return url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '';
}

/** Loopback, RFC1918, link-local, private IPv6 — plus DNS special-use labels. */
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
    // IPv6: loopback, unspecified, fc00::/7 (unique local), fe80::/10 (link-local)
    if (/^f[cd]/.test(h)) return true;
    if (/^fe[89abcd]/.test(h)) return true;
    if (h === '::' || h === '::1') return true;
  }
  return false;
}

/** Does the allowed-origin entry cover this destination? `*` = any PUBLIC site. */
export function allowedOriginMatches(origin: string, url: URL): boolean {
  const o = origin.trim();
  if (o === '*') return !isPrivateHost(url.hostname) && !blockedNetworkHost(url.toString());
  if (o.endsWith('/*')) {
    try {
      return bandMatch(o.slice(0, -2), url);
    } catch {
      return false;
    }
  }
  if (/:\*$/.test(o)) {
    try {
      const base = o.slice(0, -2);
      const allowed = new URL(base);
      const host = allowed.hostname.toLowerCase();
      return url.protocol === allowed.protocol && url.hostname.toLowerCase() === host;
    } catch {
      return false;
    }
  }
  try {
    return bandMatch(o, url);
  } catch {
    return false;
  }
}

function bandMatch(origin: string, url: URL): boolean {
  const allowed = new URL(origin);
  return (
    url.protocol === allowed.protocol &&
    url.hostname.toLowerCase() === allowed.hostname.toLowerCase() &&
    effectivePort(url) === effectivePort(allowed)
  );
}

export function validateBrowserDestination(url: string | undefined, allowedOrigins: string[]): { allowed: true; url: string } | { allowed: false; reason: string } {
  if (!url) return { allowed: false, reason: 'missing_url' };
  if (url.length > BROWSER_MAX_URL_LENGTH) return { allowed: false, reason: 'url_too_long' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'malformed_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'unsupported_protocol' };
  }
  if (blockedNetworkHost(url)) return { allowed: false, reason: 'blocked_host' };
  if (!allowedOrigins.some((o) => allowedOriginMatches(o, parsed))) {
    return { allowed: false, reason: 'destination_not_in_scope' };
  }
  return { allowed: true, url: parsed.toString() };
}

/** A destination that hosts authentication / payment / credential surfaces. */
export function sensitiveDestination(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  return SENSITIVE_HOST_PATTERNS.some((re) => re.test(host));
}

// ---------------------------------------------------------------- instruction parsing

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function validCapability(v: unknown): v is Cap {
  return typeof v === 'string' && (Object.values(BrowserCapability) as string[]).includes(v);
}

function validOrigin(o: unknown): boolean {
  if (typeof o !== 'string') return false;
  const t = o.trim();
  if (t === '*') return true;
  if (t.endsWith('/*') || /:\*$/.test(t)) return validOriginBase(t.slice(0, t.endsWith('/*') ? -2 : -1));
  return validOriginBase(t);
}

function validOriginBase(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function stringField(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== 'string' || v.length === 0 || v.length > maxLen) return undefined;
  return v;
}

/** Validate and normalize an instruction. Returns the canonical form or a reason. */
export function parseBrowserInstruction(raw: unknown): BrowserParseResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'instruction_not_object' };
  const r = raw as Record<string, unknown>;
  if (r.type !== 'browser') return { ok: false, reason: 'instruction_type_nebrowser' };
  const grants = (r.grants ?? {}) as Record<string, unknown>;
  if (!Array.isArray(grants.capabilities)) return { ok: false, reason: 'grants_capabilities_required' };
  const capabilities = dedupe((grants.capabilities as unknown[]).filter(validCapability));
  if (capabilities.length === 0) return { ok: false, reason: 'grants_capabilities_empty' };
  if (!Array.isArray(grants.allowedOrigins)) return { ok: false, reason: 'grants_origins_required' };
  const allowedOrigins = dedupe((grants.allowedOrigins as unknown[]).map((x) => (typeof x === 'string' ? x.trim() : '')).filter((o) => o !== '' && validOrigin(o)));
  if (allowedOrigins.length === 0) return { ok: false, reason: 'grants_origins_empty' };
  if (allowedOrigins.length > BROWSER_ORIGIN_MAX) return { ok: false, reason: 'grants_origins_too_many' };
  const lifetimeMs =
    typeof grants.lifetimeMs === 'number' && Number.isFinite(grants.lifetimeMs)
      ? Math.min(Math.max(grants.lifetimeMs, 0), BROWSER_PERMISSION_MAX_LIFETIME_MS)
      : BROWSER_PERMISSION_MAX_LIFETIME_MS;
  if (!Array.isArray(r.actions)) return { ok: false, reason: 'actions_required' };
  if (r.actions.length === 0) return { ok: false, reason: 'actions_empty' };
  if (r.actions.length > BROWSER_MAX_ACTIONS) return { ok: false, reason: 'actions_too_many' };
  const instruction: BrowserInstruction = { type: 'browser', grants: { capabilities, allowedOrigins, lifetimeMs }, actions: [] };
  for (const rawAction of r.actions as unknown[]) {
    if (!rawAction || typeof rawAction !== 'object') return { ok: false, reason: 'action_not_object' };
    const act = rawAction as Record<string, unknown>;
    const op = act.op;
    if (typeof op !== 'string' || !(Object.values(BrowserActionOp) as string[]).includes(op)) return { ok: false, reason: 'action_unknown_op' };
    const o = op as Op;
    const required = BROWSER_OP_TO_CAPABILITY[o];
    if (!capabilities.includes(required)) return { ok: false, reason: `capability_not_granted_${o}` };
    const action: BrowserAction = { op: o };
    switch (o) {
      case BrowserActionOp.OPEN:
      case BrowserActionOp.NAVIGATE: {
        const url = stringField(act.url, BROWSER_MAX_URL_LENGTH);
        if (!url) return { ok: false, reason: `op_${o}_requires_url` };
        const dest = validateBrowserDestination(url, allowedOrigins);
        if (!dest.allowed) return { ok: false, reason: `op_${o}_${dest.reason}` };
        action.url = dest.url;
        break;
      }
      case BrowserActionOp.DOWNLOAD: {
        if (act.url !== undefined) {
          const url = stringField(act.url, BROWSER_MAX_URL_LENGTH);
          if (!url) return { ok: false, reason: 'op_download_invalid_url' };
          const dest = validateBrowserDestination(url, allowedOrigins);
          if (!dest.allowed) return { ok: false, reason: `op_download_${dest.reason}` };
          action.url = dest.url;
        }
        if (act.path !== undefined) {
          const path = stringField(act.path, 512);
          if (!path) return { ok: false, reason: 'op_download_invalid_path' };
          action.path = path;
        }
        break;
      }
      case BrowserActionOp.READ:
      case BrowserActionOp.INSPECT: {
        if (act.selector !== undefined) {
          const sel = stringField(act.selector, BROWSER_MAX_SELECTOR_LENGTH);
          if (!sel) return { ok: false, reason: `op_${o}_invalid_selector` };
          action.selector = sel;
        }
        break;
      }
      case BrowserActionOp.SEARCH: {
        const query = stringField(act.query, BROWSER_MAX_TEXT_LENGTH);
        if (!query) return { ok: false, reason: 'op_search_requires_query' };
        action.query = query;
        break;
      }
      case BrowserActionOp.EXTRACT: {
        if (!Array.isArray(act.selectors) || act.selectors.length === 0 || act.selectors.length > 32) {
          return { ok: false, reason: 'op_extract_requires_selectors' };
        }
        const selectors: string[] = [];
        for (const s of act.selectors) {
          const sel = stringField(s, BROWSER_MAX_SELECTOR_LENGTH);
          if (!sel) return { ok: false, reason: 'op_extract_invalid_selector' };
          selectors.push(sel);
        }
        action.selectors = selectors;
        break;
      }
      case BrowserActionOp.SCROLL: {
        const dir = act.direction;
        if (dir !== 'up' && dir !== 'down' && dir !== 'top' && dir !== 'bottom') {
          return { ok: false, reason: 'op_scroll_invalid_direction' };
        }
        action.direction = dir;
        if (act.amount !== undefined) {
          if (typeof act.amount !== 'number' || !Number.isFinite(act.amount) || act.amount < 0 || act.amount > 100_000) {
            return { ok: false, reason: 'op_scroll_invalid_amount' };
          }
          action.amount = act.amount;
        }
        break;
      }
      case BrowserActionOp.CLICK:
      case BrowserActionOp.SUBMIT: {
        const sel = stringField(act.selector, BROWSER_MAX_SELECTOR_LENGTH);
        if (!sel) return { ok: false, reason: `op_${o}_requires_selector` };
        action.selector = sel;
        break;
      }
      case BrowserActionOp.TYPE: {
        const sel = stringField(act.selector, BROWSER_MAX_SELECTOR_LENGTH);
        if (!sel) return { ok: false, reason: 'op_type_requires_selector' };
        const text = stringField(act.text, BROWSER_MAX_TEXT_LENGTH);
        if (text === undefined) return { ok: false, reason: 'op_type_requires_text' };
        action.selector = sel;
        action.text = text;
        break;
      }
      case BrowserActionOp.SELECT: {
        const sel = stringField(act.selector, BROWSER_MAX_SELECTOR_LENGTH);
        if (!sel) return { ok: false, reason: 'op_select_requires_selector' };
        const value = stringField(act.value, 512);
        if (value === undefined) return { ok: false, reason: 'op_select_requires_value' };
        action.selector = sel;
        action.value = value;
        break;
      }
      case BrowserActionOp.UPLOAD: {
        const sel = stringField(act.selector, BROWSER_MAX_SELECTOR_LENGTH);
        if (!sel) return { ok: false, reason: 'op_upload_requires_selector' };
        const path = stringField(act.path, 512);
        if (!path) return { ok: false, reason: 'op_upload_requires_path' };
        action.selector = sel;
        action.path = path;
        break;
      }
      case BrowserActionOp.BACK:
      case BrowserActionOp.FORWARD:
      case BrowserActionOp.RELOAD:
      case BrowserActionOp.SCREENSHOT:
        break;
    }
    instruction.actions.push(action);
  }
  if (typeof r.pinnedDeviceId === 'string' && r.pinnedDeviceId.length > 0 && r.pinnedDeviceId.length <= 128) {
    instruction.pinnedDeviceId = r.pinnedDeviceId;
  }
  return { ok: true, instruction };
}

/** Capabilities a browser task actually REQUIRES to execute its actions. */
export function browserInstructionRequiredCapabilities(instruction: unknown): Cap[] | null {
  if (!instruction || typeof instruction !== 'object') return null;
  const i = instruction as BrowserInstruction;
  if (i.type !== 'browser' || !Array.isArray(i.actions)) return null;
  const caps = new Set<Cap>();
  for (const action of i.actions) {
    const c = BROWSER_OP_TO_CAPABILITY[action.op];
    if (c) caps.add(c);
  }
  return [...caps];
}

/** Risk class of an action for the deterministic risk model (approvals/UI). */
export function browserActionRisk(op: Op): 'LOW' | 'MEDIUM' | 'HIGH' {
  switch (op) {
    case BrowserActionOp.CLICK:
      return 'MEDIUM';
    case BrowserActionOp.TYPE:
      return 'MEDIUM';
    case BrowserActionOp.SELECT:
    case BrowserActionOp.SUBMIT:
      return 'HIGH';
    case BrowserActionOp.DOWNLOAD:
    case BrowserActionOp.UPLOAD:
      return 'HIGH';
    default:
      return 'LOW';
  }
}

/** A consequential op on a sensitive destination must never be silently allowed. */
export function denySensitiveInteraction(op: Op, destination: URL | undefined): boolean {
  if (!BROWSER_CONSEQUENTIAL_OPS.has(op)) return false;
  if (!destination) return false;
  return sensitiveDestination(destination);
}