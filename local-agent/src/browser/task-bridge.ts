/**
 * CodeConClave Local Agent — browser instruction runner (P1).
 *
 * Executes a validated browser instruction the same way the P0 terminal path
 * does, with the browser-specific guarantees:
 *   - EVERY action is re-checked against the local config by
 *     assertBrowserAction BEFORE the browser is ever launched for the whole
 *     instruction, and again before each action runs;
 *   - the session is a CodeConConclave-managed disposable browser (Mode 1),
 *     isolated user-data dir, debug port on 127.0.0.1 only;
 *   - Mode 2 (controlling the user's existing authenticated tabs) is NOT
 *     implemented and fails with `browser_mode_unavailable` — never silently
 *     falls back;
 *   - real completion data only: real artifacts (screenshots/downloads) are
 *     streamed as `task_artifact` messages; failures report the exact action.
 *   - Max concurrent managed browser session on this device: 1 (mutex).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { AgentConfig } from '../config.js';
import { browserGrants, assertBrowserAction, downloadDirFor } from './contract.js';
import { BrowserController, type OpResult } from './controller.js';
import type { CdpSession } from './cdp.js';
import { launchManagedBrowser, findBrowserPath } from './launch.js';
import { redactSecrets } from './redact.js';

const MAX_TEXT_PER_TYPE = 4096;
const MAX_HEADED = process.env.CODECONCLAVE_BROWSER_HEADED === '1';

export interface BrowserRunOutcome {
  ok: boolean;
  errorCode?: string;
  error?: string;
  summary: Record<string, unknown>;
  artifacts: Record<string, unknown>[];
}

export interface BrowserRunDeps {
  send: (msg: Record<string, unknown>) => void;
  reportProgress: (progress: Record<string, unknown>) => void;
}

let sessionTail: Promise<void> = Promise.resolve();

/**
 * Serialize managed browser sessions on this device: at most one at a time, so
 * two overlapping assignments can never drive two browsers against each other.
 */
function withBrowserSession<T>(fn: () => Promise<T>): Promise<T> {
  const prev = sessionTail;
  let release!: () => void;
  sessionTail = new Promise<void>((r) => (release = r));
  return prev.then(() =>
    fn().finally(() => {
      release();
    }),
  );
}

export async function runBrowserInstruction(
  rawInstruction: Record<string, unknown>,
  config: AgentConfig,
  assignmentId: string,
  attemptNumber: number,
  deps: BrowserRunDeps,
): Promise<BrowserRunOutcome> {
  if (rawInstruction.type !== 'browser' || !Array.isArray(rawInstruction.actions)) {
    return failOutcome('browser_malformed_instruction', 'instruction is not a browser instruction', []);
  }
  if (browserGrants(config).length === 0) {
    return failOutcome('browser_capability_not_granted', 'no browser grant is enabled on this device (run `codeconclave-agent browser enable`)', []);
  }
  const actions = rawInstruction.actions as Record<string, unknown>[];
  const pinned = typeof rawInstruction.pinnedDeviceId === 'string' ? rawInstruction.pinnedDeviceId : undefined;
  if (pinned && pinned !== config.deviceId) {
    return failOutcome('browser_wrong_device', 'instruction is pinned to a different device', []);
  }

  // Pass 0 — reject malformed/unauthorized requests BEFORE touching a browser.
  for (let i = 0; i < actions.length; i++) {
    const gate = assertBrowserAction(actions[i]!, config);
    if (!gate.ok) {
      return failOutcome2('browser_action_failed', i, actions[i]!.op, gate.reason, []);
    }
  }

  return withBrowserSession(() => executeInstruction(actions, config, assignmentId, attemptNumber, deps));
}

async function executeInstruction(
  actions: Record<string, unknown>[],
  config: AgentConfig,
  assignmentId: string,
  attemptNumber: number,
  deps: BrowserRunDeps,
): Promise<BrowserRunOutcome> {
  const workspace = (config.workspaces ?? []).find((w) => (w.capabilities ?? []).includes('terminal_exec'));
  const downloadDir = workspace ? downloadDirFor(workspace, assignmentId) : join(tmpdir(), 'ccc-browser-downloads', String(assignmentId).slice(0, 96));
  const evidenceDir = join(downloadDir, 'evidence');
  const workspaceRoot = workspace?.root;

  const artifacts: Record<string, unknown>[] = [];
  const post = (artifact: Record<string, unknown>) => {
    artifacts.push(artifact);
    deps.send({ type: 'task_artifact', assignmentId, attemptNumber, artifact });
  };

  deps.reportProgress({ step: 'starting', actions: actions.length });

  let cdpSession: CdpSession | null = null;
  let controller: BrowserController | null = null;
  let cleanup: (() => Promise<void>) | null = null;
  try {
    const browserPath = findBrowserPath();
    if (!browserPath) {
      return failOutcome('browser_not_found', 'no supported Chromium/Edge found (set CODECONCLAVE_BROWSER_PATH)', artifacts);
    }
    const launch = await launchManagedBrowserWithRetry({
      headless: !MAX_HEADED,
      userDataDir: mkdtempSync(join(tmpdir(), 'ccc-browser-')),
      downloadDir,
      port: randomPort(),
      browserPath: browserPath ?? undefined,
    });
    cdpSession = launch.session;
    cleanup = launch.cleanup;
    controller = new BrowserController(cdpSession, { screenshotMaxBytes: 8 * 1024 * 1024 });

    deps.reportProgress({ step: 'running', actions: actions.length });
    const summaries: Record<string, unknown>[] = [];

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]!;
      const op = String(action.op ?? '');
      // Pass 1 — re-check immediately before it can touch the page.
      const gate = assertBrowserAction(action, config);
      if (!gate.ok) {
        return failOutcome2('browser_action_failed', i, op, `denied: ${gate.reason}`, artifacts);
      }
      const result = await executeOne(op, action, controller, {
        evidenceDir,
        downloadDir,
        uploadPath: gate.absUploadPath,
        assignmentId,
        index: i,
      });
      if (!result.ok) {
        return {
          ok: false,
          errorCode: 'browser_action_failed',
          error: JSON.stringify({ actionIndex: i, op, reason: safeError(result.error) }),
          summary: { actionsAttempted: i + 1, actionsTotal: actions.length, lastOp: op, lastError: safeError(result.error) },
          artifacts,
        };
      }
      const safe = redactSummary(result.data);
      const artifact = safe.artifact as { path?: string; absPath?: string; bytes?: number; sha256?: string } | undefined;
      if (artifact?.absPath) {
        const relPath = workspaceRoot && artifact.absPath.startsWith(workspaceRoot) ? relative(workspaceRoot, artifact.absPath) : artifact.path;
        post({ kind: String(safe.kind ?? 'browser_evidence'), path: relPath, absPath: artifact.absPath, bytes: artifact.bytes ?? 0, sha256: String(artifact.sha256 ?? '') });
      }
      summaries.push({ index: i, op, ...safe });
      deps.reportProgress({ step: 'action', index: i, op, done: summaries.length, actionsTotal: actions.length });
    }

    deps.reportProgress({ step: 'finished', ok: true, actions: actions.length });
    const finalState = controller ? await controller.pageState() : null;
    return {
      ok: true,
      errorCode: undefined,
      error: undefined,
      summary: {
        ok: true,
        actions: actions.length,
        pagesOpened: finalState?.url ?? null,
        finalUrl: finalState?.url ?? null,
        finalTitle: finalState?.title ?? null,
        evidence: artifacts.length,
      },
      artifacts,
    };
  } catch (err) {
    return {
      ok: false,
      errorCode: 'browser_executor_error',
      error: err instanceof Error ? redactSecrets(err.message) : 'unexpected browser executor failure',
      summary: { ok: false },
      artifacts,
    };
  } finally {
    deps.reportProgress({ step: 'cleanup' });
    if (controller) controller.dispose();
    if (cleanup) await cleanup().catch(() => undefined);
  }
}

// ------------------------------------------------------------------ op exec

async function executeOne(
  op: string,
  action: Record<string, unknown>,
  controller: BrowserController,
  ctx: {
    evidenceDir: string;
    downloadDir: string;
    uploadPath?: string;
    assignmentId: string;
    index: number;
  },
): Promise<OpResult> {
  switch (op) {
    case 'open':
    case 'navigate':
      return controller.open(String(action.url ?? ''));
    case 'back':
      return controller.back();
    case 'forward':
      return controller.forward();
    case 'reload':
      return controller.reload();
    case 'read':
      return typeof action.selector === 'string' ? controller.read(action.selector) : controller.read(undefined);
    case 'inspect':
      return typeof action.selector === 'string' ? controller.inspect(action.selector) : controller.inspect(undefined);
    case 'search':
      return controller.search(String(action.query ?? ''));
    case 'extract': {
      const selectors = Array.isArray(action.selectors) ? (action.selectors as string[]).filter((s) => typeof s === 'string') : [];
      return controller.extract(selectors);
    }
    case 'scroll': {
      const dir = String(action.direction ?? 'down');
      const amt = typeof action.amount === 'number' ? action.amount : undefined;
      return controller.scroll(dir as 'up' | 'down' | 'top' | 'bottom', amt);
    }
    case 'click':
      return controller.click(String(action.selector ?? ''));
    case 'type':
      return controller.type(String(action.selector ?? ''), String(action.text ?? '').slice(0, MAX_TEXT_PER_TYPE));
    case 'select':
      return controller.select(String(action.selector ?? ''), String(action.value ?? ''));
    case 'submit':
      return controller.submit(String(action.selector ?? ''));
    case 'screenshot': {
      const absPath = join(ctx.evidenceDir, `${ctx.assignmentId}-${String(ctx.index).padStart(2, '0')}.png`);
      const r = await controller.screenshot(absPath);
      if (r.ok) r.data = { ...r.data, kind: 'browser_screenshot', artifact: { path: r.data.path, absPath: r.data.absPath, bytes: r.data.bytes, sha256: r.data.sha256 } };
      return r;
    }
    case 'download': {
      const r = await (typeof action.url === 'string' && action.url ? controller.download(action.url, ctx.downloadDir) : controller.download(undefined, ctx.downloadDir));
      if (r.ok) r.data = { ...r.data, kind: 'browser_download', artifact: { path: r.data.path, absPath: r.data.absPath, bytes: r.data.bytes, sha256: r.data.sha256 } };
      return r;
    }
    case 'upload':
      return controller.upload(String(action.selector ?? ''), String(ctx.uploadPath ?? ''));
    default:
      return { ok: false, error: `unsupported_op_${op}` };
  }
}

// ------------------------------------------------------------------ helpers

function failOutcome(errorCode: string, error: string, artifacts: Record<string, unknown>[]): BrowserRunOutcome {
  return { ok: false, errorCode, error, summary: { ok: false }, artifacts };
}

function failOutcome2(errorCode: string, actionIndex: number, op: unknown, reason: string, artifacts: Record<string, unknown>[]): BrowserRunOutcome {
  return {
    ok: false,
    errorCode,
    error: JSON.stringify({ actionIndex, op: typeof op === 'string' ? op : undefined, reason: safeError(reason) }),
    summary: { ok: false, actionsAttempted: actionIndex + 1, lastError: safeError(reason) },
    artifacts,
  };
}

function safeError(text: string): string {
  return redactSecrets(text).slice(0, 500) || 'unknown_error';
}

function redactSummary(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(data ?? {})) {
    if (k === 'text' || k === 'snippet' || k === 'reason') {
      out[k] = redactSecrets(String(data[k] ?? ''));
    } else {
      out[k] = data[k];
    }
  }
  // Ensure we never relay full page bytes back to the server.
  delete out.text;
  delete out.snippet;
  return out;
}

function randomPort(): number {
  return 20_000 + Math.floor(Math.random() * 25_000);
}

async function launchManagedBrowserWithRetry(options: Parameters<typeof launchManagedBrowser>[0]) {
  try {
    return await launchManagedBrowser(options);
  } catch (err) {
    // Port collisions are the likeliest launch failure — retry once on a new port.
    const second = launchManagedBrowser({ ...options, port: randomPort() });
    try {
      return await second;
    } catch (err2) {
      throw err ?? err2;
    }
  }
}