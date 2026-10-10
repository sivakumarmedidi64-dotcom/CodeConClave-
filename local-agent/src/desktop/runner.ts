/**
 * CodeConClave Local Agent — P2 desktop-control runner.
 *
 * A deliberately minimal, deny-by-default desktop surface: enumerate visible
 * windows, launch an explicitly allow-listed application, and focus an
 * already-open window. There is NO free-form desktop execution. The only real
 * implementation is Windows (PowerShell + COM WScript.Shell); every other
 * platform fails honestly with `desktop_unsupported_platform` — the runner
 * never fabricates a desktop action.
 *
 * The cloud re-checks the same rules before dispatch; this module is the local
 * enforcement boundary.
 */
import { runCommandOnce } from '../terminal.js';
import type { AgentConfig } from '../config.js';
import type { ExecutionOutcome } from '../tasks.js';

export const DESKTOP_CAPABILITIES = ['desktop.inspect', 'desktop.open_app', 'desktop.focus_window'] as const;
export const DESKTOP_MAX_ACTIONS = 10;
export const DESKTOP_MAX_WINDOW_TITLE = 256;
export const DESKTOP_MAX_APP_ID = 64;

export const DESKTOP_OP_CAPABILITY: Readonly<Record<string, string>> = {
  list_windows: 'desktop.inspect',
  open_app: 'desktop.open_app',
  focus_window: 'desktop.focus_window',
};

export function desktopControlEnabled(): boolean {
  return String(process.env.DESKTOP_CONTROL_ENABLED ?? '').toLowerCase() === 'true';
}

export function desktopAllowedApps(): string[] {
  return String(process.env.DESKTOP_ALLOWED_APPS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Union of capabilities across the device's desktop grants. */
export function desktopGrantedCaps(config: AgentConfig): string[] {
  const caps = new Set<string>();
  for (const g of config.desktop ?? []) {
    for (const c of g.capabilities ?? []) caps.add(c);
  }
  return [...caps];
}

/** Capabilities the device honestly claims at register time (gated by env). */
export function advertisedDesktopCapabilities(config: AgentConfig): string[] {
  if (!desktopControlEnabled()) return [];
  const known = new Set<string>(DESKTOP_CAPABILITIES);
  const caps = new Set<string>();
  for (const g of config.desktop ?? []) {
    if (!Array.isArray(g.capabilities)) continue;
    if (!g.capabilities.every((c) => known.has(c))) continue;
    for (const c of g.capabilities) caps.add(c);
  }
  return [...caps];
}

/** Infer required desktop.* caps straight from the instruction actions. */
export function desktopRequiredCapabilities(instruction: Record<string, unknown>): string[] {
  const actions = Array.isArray(instruction.actions) ? (instruction.actions as Record<string, unknown>[]) : [];
  const caps = new Set<string>();
  for (const action of actions) {
    if (action && typeof action.op === 'string') {
      const c = DESKTOP_OP_CAPABILITY[action.op];
      if (c) caps.add(c);
    }
  }
  return [...caps];
}

// ---------------------------------------------------------------- command builders

/** Single-quote a value for a PowerShell command line. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildListWindowsCommand(): string {
  return 'Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress';
}

export function buildOpenAppCommand(app: string): string {
  return `Start-Process -FilePath ${psQuote(app)}`;
}

export function buildFocusWindowCommand(title: string): string {
  return `$w = New-Object -ComObject WScript.Shell; if ($w.AppActivate(${psQuote(title)})) { 'FOCUSED' } else { 'NOT_FOUND' }`;
}

export interface DesktopWindow {
  id: number;
  process: string;
  title: string;
}

/** Parse the JSON (or single-object) output of `buildListWindowsCommand`. */
export function parseWindows(raw: string): DesktopWindow[] {
  const text = raw.trim();
  if (!text || text === 'null') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const windows: DesktopWindow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const title = typeof r.MainWindowTitle === 'string' ? r.MainWindowTitle : '';
    if (!title) continue;
    windows.push({
      id: typeof r.Id === 'number' ? r.Id : Number(r.Id) || 0,
      process: typeof r.ProcessName === 'string' ? r.ProcessName : '',
      title,
    });
  }
  return windows;
}

export interface DesktopRunDeps {
  send: (msg: Record<string, unknown>) => void;
  reportProgress: (progress: Record<string, unknown>) => void;
  run?: typeof runCommandOnce;
  platform?: NodeJS.Platform;
}

function fail(errorCode: string, error: string, actionsAttempted: number): ExecutionOutcome {
  return { ok: false, errorCode, error, summary: { actionsAttempted }, artifacts: [] };
}

/** Execute a validated desktop instruction and report the REAL result. */
export async function runDesktopInstruction(
  instruction: Record<string, unknown>,
  config: AgentConfig,
  _assignmentId: string,
  _attemptNumber: number,
  deps: DesktopRunDeps,
): Promise<ExecutionOutcome> {
  const run = deps.run ?? runCommandOnce;
  const platform = deps.platform ?? process.platform;

  if (!desktopControlEnabled()) {
    return fail('desktop_not_enabled', 'Desktop control is disabled on this device (set DESKTOP_CONTROL_ENABLED=true)', 0);
  }
  if (platform !== 'win32') {
    return fail('desktop_unsupported_platform', `Desktop control is not implemented on ${platform}`, 0);
  }
  const actions = Array.isArray(instruction.actions) ? (instruction.actions as Record<string, unknown>[]) : [];
  if (actions.length === 0) return fail('desktop_invalid_instruction', 'instruction carries no actions', 0);
  if (actions.length > DESKTOP_MAX_ACTIONS) return fail('desktop_invalid_instruction', 'too many actions', 0);

  const granted = desktopGrantedCaps(config);
  const missing = desktopRequiredCapabilities(instruction).filter((c) => !granted.includes(c));
  if (missing.length > 0) {
    return fail('desktop_capability_not_granted', `No desktop grant provides ${missing.join(', ')} — refused`, 0);
  }

  const allowlist = desktopAllowedApps();
  let attempted = 0;
  let windows: DesktopWindow[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    const op = typeof action.op === 'string' ? action.op : '';
    attempted = index + 1;

    if (op === 'open_app') {
      const app = typeof action.app === 'string' ? action.app.toLowerCase() : '';
      if (!app || !allowlist.includes(app)) {
        return fail('desktop_app_not_allowlisted', `application ${JSON.stringify(app)} is not on this device's allowlist`, index);
      }
    }

    const command =
      op === 'list_windows'
        ? buildListWindowsCommand()
        : op === 'open_app'
          ? buildOpenAppCommand(String(action.app))
          : op === 'focus_window'
            ? buildFocusWindowCommand(String(action.title))
            : '';
    if (!command) return fail('desktop_invalid_instruction', `unknown op ${JSON.stringify(op)}`, index);

    deps.reportProgress({ step: 'action', index: index + 1, op });
    const result = await run('powershell', command, process.cwd(), { timeoutMs: 15_000, maxBytes: 256 * 1024 });
    if (!result.ok || result.timedOut || (result.exitCode !== 0 && result.exitCode !== null)) {
      return fail('desktop_action_failed', `action ${index + 1} (${op}) failed: ${(result.error ?? result.output).slice(0, 500)}`, attempted);
    }

    if (op === 'focus_window') {
      if (result.output.includes('NOT_FOUND')) {
        return fail('desktop_action_failed', `action ${index + 1} (focus_window) found no matching window`, attempted);
      }
      deps.reportProgress({ step: 'action_done', index: index + 1, op, focused: true });
    } else if (op === 'list_windows') {
      windows = parseWindows(result.output);
      deps.reportProgress({ step: 'action_done', index: index + 1, op, windows: windows.length });
    } else {
      deps.reportProgress({ step: 'action_done', index: index + 1, op, app: action.app });
    }
  }

  return {
    ok: true,
    summary: { platform, actionsAttempted: attempted, windows: windows.map((w) => ({ process: w.process, title: w.title })) },
    artifacts: [],
  };
}
