/**
 * CodeConClave — P1 browser-instruction authoring helpers (WorkPage panel).
 *
 * The backend (backend/src/modules/agent/browser-policy.ts + shared constants)
 * is the authoritative contract: instructions are fully re-validated on POST.
 * These helpers only mirror the op→capability map so the panel can (a) derive a
 * valid grants set from the chosen actions and (b) author-time flag obvious
 * mistakes. A mismatch is never silent: the server rejects with a reason that
 * is surfaced to the user.
 */

export const BrowserCapability = {
  OPEN: 'browser.open',
  NAVIGATE: 'browser.navigate',
  READ: 'browser.read',
  INSPECT: 'browser.inspect',
  CLICK: 'browser.click',
  TYPE: 'browser.type',
  SUBMIT: 'browser.submit',
  DOWNLOAD: 'browser.download',
  UPLOAD: 'browser.upload',
} as const;
export type BrowserCapability = (typeof BrowserCapability)[keyof typeof BrowserCapability];

export const BrowserOp = {
  OPEN: 'open',
  NAVIGATE: 'navigate',
  BACK: 'back',
  FORWARD: 'forward',
  RELOAD: 'reload',
  READ: 'read',
  INSPECT: 'inspect',
  SEARCH: 'search',
  EXTRACT: 'extract',
  SCROLL: 'scroll',
  CLICK: 'click',
  TYPE: 'type',
  SELECT: 'select',
  SUBMIT: 'submit',
  SCREENSHOT: 'screenshot',
  DOWNLOAD: 'download',
  UPLOAD: 'upload',
} as const;
export type BrowserOp = (typeof BrowserOp)[keyof typeof BrowserOp];

export const BROWSER_MAX_ACTIONS = 20;
export const BROWSER_MAX_ORIGINS = 20;
export const BROWSER_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const BROWSER_DEFAULT_LIFETIME_MS = 60 * 60 * 1000;

/** Every op requires exactly one capability grant (mirror of browser-policy). */
export const BROWSER_OP_TO_CAPABILITY: Readonly<Record<BrowserOp, BrowserCapability>> = {
  [BrowserOp.OPEN]: BrowserCapability.OPEN,
  [BrowserOp.NAVIGATE]: BrowserCapability.NAVIGATE,
  [BrowserOp.BACK]: BrowserCapability.NAVIGATE,
  [BrowserOp.FORWARD]: BrowserCapability.NAVIGATE,
  [BrowserOp.RELOAD]: BrowserCapability.NAVIGATE,
  [BrowserOp.READ]: BrowserCapability.READ,
  [BrowserOp.INSPECT]: BrowserCapability.INSPECT,
  [BrowserOp.SEARCH]: BrowserCapability.READ,
  [BrowserOp.EXTRACT]: BrowserCapability.READ,
  [BrowserOp.SCROLL]: BrowserCapability.READ,
  [BrowserOp.CLICK]: BrowserCapability.CLICK,
  [BrowserOp.TYPE]: BrowserCapability.TYPE,
  [BrowserOp.SELECT]: BrowserCapability.SUBMIT,
  [BrowserOp.SUBMIT]: BrowserCapability.SUBMIT,
  [BrowserOp.SCREENSHOT]: BrowserCapability.INSPECT,
  [BrowserOp.DOWNLOAD]: BrowserCapability.DOWNLOAD,
  [BrowserOp.UPLOAD]: BrowserCapability.UPLOAD,
};

export interface BrowserActionInput {
  op: BrowserOp;
  url?: string;
  selector?: string;
  text?: string;
  value?: string;
  query?: string;
  selectors?: string[];
  direction?: 'up' | 'down' | 'top' | 'bottom';
  amount?: number;
  path?: string;
}

export interface BrowserInstruction {
  type: 'browser';
  grants: { capabilities: BrowserCapability[]; allowedOrigins: string[]; lifetimeMs: number };
  actions: BrowserActionInput[];
  pinnedDeviceId?: string;
}

/** Capabilities a set of actions actually requires. */
export function deriveBrowserCapabilities(actions: BrowserActionInput[]): BrowserCapability[] {
  const caps = new Set<BrowserCapability>();
  for (const a of actions) caps.add(BROWSER_OP_TO_CAPABILITY[a.op]);
  return [...caps];
}

/** Canonical origin of a http(s) URL, or null for non-http(s)/malformed input. */
export function originOf(rawUrl: string): string | null {
  const trimmed = (rawUrl ?? '').trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const port = u.port ? `:${u.port}` : '';
    return `${u.protocol}//${u.hostname}${port}`;
  } catch {
    return null;
  }
}

/** Union of explicit origins + every action URL origin (per-op scope, same
 *  origin as the URL the agent will open/navigate to). */
export function effectiveAllowedOrigins(actions: BrowserActionInput[], extra: string[] = []): string[] {
  const set = new Set<string>();
  for (const a of actions) {
    if (a.op === BrowserOp.OPEN || a.op === BrowserOp.NAVIGATE || a.op === BrowserOp.DOWNLOAD) {
      if (a.url) {
        const o = originOf(a.url);
        if (o) set.add(o);
      }
    }
  }
  for (const e of extra) {
    const t = (e ?? '').trim();
    if (t) set.add(t);
  }
  const out = [...set];
  if (out.length > BROWSER_MAX_ORIGINS) out.length = BROWSER_MAX_ORIGINS;
  return out;
}

/**
 * Author-time validation so a malformed instruction is caught before POST.
 * The backend remains authoritative and re-validates everywhere.
 */
export function validateAction(op: BrowserOp, a: BrowserActionInput): string | null {
  switch (op) {
    case BrowserOp.OPEN:
    case BrowserOp.NAVIGATE:
      if (!a.url || !a.url.trim()) return `${op} requires a url`;
      if (!originOf(a.url)) return `${op} url must be a valid http(s) URL`;
      return null;
    case BrowserOp.READ:
    case BrowserOp.INSPECT:
      return null;
    case BrowserOp.SEARCH:
      if (!a.query || !a.query.trim()) return 'search requires a query';
      return null;
    case BrowserOp.EXTRACT: {
      const sels = a.selectors ?? [];
      if (sels.length === 0 || sels.some((s) => !s.trim())) return 'extract requires at least one selector';
      return null;
    }
    case BrowserOp.SCROLL:
      if (!a.direction) return 'scroll requires a direction';
      if (a.amount !== undefined && (typeof a.amount !== 'number' || !Number.isFinite(a.amount) || a.amount < 0 || a.amount > 100_000)) {
        return 'scroll amount must be 0..100000';
      }
      return null;
    case BrowserOp.CLICK:
      if (!a.selector || !a.selector.trim()) return 'click requires a selector';
      return null;
    case BrowserOp.TYPE:
      if (!a.selector || !a.selector.trim()) return 'type requires a selector';
      if (!a.text || !a.text.trim()) return 'type requires text';
      return null;
    case BrowserOp.SELECT:
      if (!a.selector || !a.selector.trim()) return 'select requires a selector';
      if (!a.value || !a.value.trim()) return 'select requires a value';
      return null;
    case BrowserOp.SUBMIT:
      if (!a.selector || !a.selector.trim()) return 'submit requires a selector';
      return null;
    case BrowserOp.DOWNLOAD:
      return null;
    case BrowserOp.UPLOAD:
      if (!a.selector || !a.selector.trim()) return 'upload requires a selector';
      if (!a.path || !a.path.trim()) return 'upload requires a path';
      return null;
    case BrowserOp.BACK:
    case BrowserOp.FORWARD:
    case BrowserOp.RELOAD:
    case BrowserOp.SCREENSHOT:
      return null;
  }
  return null;
}

export interface BuildResult {
  instruction: BrowserInstruction | null;
  error: string | null;
}

/**
 * Build a complete instruction from authored actions. Derives capabilities
 * from the actions and the allowed-origin set from the action URLs (+extras).
 */
export function buildBrowserInstruction(input: {
  actions: BrowserActionInput[];
  extraOrigins?: string[];
  lifetimeMs?: number;
}): BuildResult {
  const actions = input.actions.filter((a) => a && typeof a.op === 'string');
  if (actions.length === 0) return { instruction: null, error: 'add at least one action' };
  if (actions.length > BROWSER_MAX_ACTIONS) return { instruction: null, error: `at most ${BROWSER_MAX_ACTIONS} actions` };
  for (let i = 0; i < actions.length; i++) {
    const reason = validateAction(actions[i]!.op, actions[i]!);
    if (reason) return { instruction: null, error: `action ${i + 1}: ${reason}` };
  }
  const capabilities = deriveBrowserCapabilities(actions);
  const allowedOrigins = effectiveAllowedOrigins(actions, input.extraOrigins);
  if (allowedOrigins.length === 0) return { instruction: null, error: 'no allowed origin derivable — every open/navigate URL must be a valid http(s) URL' };
  const lifetimeMs = Math.min(Math.max(input.lifetimeMs ?? BROWSER_DEFAULT_LIFETIME_MS, 0), BROWSER_MAX_LIFETIME_MS);
  return {
    instruction: {
      type: 'browser',
      grants: { capabilities, allowedOrigins, lifetimeMs },
      actions: actions.map((a) => ({ ...a })),
    },
    error: null,
  };
}

/** Compact one-line summary of an action for the list UI. */
export function summarizeAction(a: BrowserActionInput): string {
  const parts: string[] = [a.op];
  if (a.url) parts.push(a.url);
  if (a.selector) parts.push(a.selector);
  if (a.text) parts.push(`"${a.text.slice(0, 48)}${a.text.length > 48 ? '…' : ''}"`);
  if (a.value) parts.push(`=${a.value}`);
  if (a.query) parts.push(`"${a.query.slice(0, 48)}${a.query.length > 48 ? '…' : ''}"`);
  if (a.path) parts.push(a.path);
  if (a.direction) parts.push(a.direction);
  if (a.amount !== undefined) parts.push(`×${a.amount}`);
  return parts.join(' ');
}

export const OP_FIELD_SET = {
  url: new Set<BrowserOp>([BrowserOp.OPEN, BrowserOp.NAVIGATE, BrowserOp.DOWNLOAD]),
  selector: new Set<BrowserOp>([BrowserOp.READ, BrowserOp.INSPECT, BrowserOp.CLICK, BrowserOp.TYPE, BrowserOp.SELECT, BrowserOp.SUBMIT, BrowserOp.UPLOAD]),
  text: new Set<BrowserOp>([BrowserOp.TYPE]),
  value: new Set<BrowserOp>([BrowserOp.SELECT]),
  query: new Set<BrowserOp>([BrowserOp.SEARCH]),
  direction: new Set<BrowserOp>([BrowserOp.SCROLL]),
  selectors: new Set<BrowserOp>([BrowserOp.EXTRACT]),
  path: new Set<BrowserOp>([BrowserOp.UPLOAD, BrowserOp.DOWNLOAD]),
} as const;

export const OP_LABELS: Readonly<Record<BrowserOp, string>> = {
  [BrowserOp.OPEN]: 'Open URL',
  [BrowserOp.NAVIGATE]: 'Navigate',
  [BrowserOp.BACK]: 'Back',
  [BrowserOp.FORWARD]: 'Forward',
  [BrowserOp.RELOAD]: 'Reload',
  [BrowserOp.READ]: 'Read page',
  [BrowserOp.INSPECT]: 'Inspect',
  [BrowserOp.SEARCH]: 'Search text',
  [BrowserOp.EXTRACT]: 'Extract selectors',
  [BrowserOp.SCROLL]: 'Scroll',
  [BrowserOp.CLICK]: 'Click',
  [BrowserOp.TYPE]: 'Type',
  [BrowserOp.SELECT]: 'Select option',
  [BrowserOp.SUBMIT]: 'Submit',
  [BrowserOp.SCREENSHOT]: 'Screenshot',
  [BrowserOp.DOWNLOAD]: 'Download',
  [BrowserOp.UPLOAD]: 'Upload',
};

export const BROWSER_OPS: BrowserOp[] = [...(Object.values(BrowserOp) as BrowserOp[])];