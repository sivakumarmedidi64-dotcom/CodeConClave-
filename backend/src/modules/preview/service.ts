/**
 * CodeConClave — main-workspace live preview (Stage 25.5).
 * One preview session per project. States are server-derived and honest:
 * BUILDING/UPDATING only while a real build runs, READY only after a build
 * produced output, NOT_CONFIGURED when no preview tooling is configured on
 * this deployment. The UI never fabricates a rendered preview.
 */
import { pool, queryMany, queryOne } from '../../shared/db.js';
import { newId } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { env } from '../../config/env.js';
import { AuditAction, NotificationType, PreviewState } from '@codeconclave/shared';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

export const PREVIEW_STATES = Object.values(PreviewState) as string[];

export interface PreviewSessionRow {
  id: string;
  owner_id: string;
  project_id: string;
  state: string;
  build_log: string[];
  error: string | null;
  task_id: string | null;
  version: number;
  updated_at: Date;
  created_at: Date;
}

/** SSE subscribers per project (in-memory; reconnected on reload). */
const subscribers = new Map<string, Set<(event: { state: string; version: number; taskId: string | null; error: string | null }) => void>>();

export function subscribePreview(
  projectId: string,
  cb: (event: { state: string; version: number; taskId: string | null; error: string | null }) => void,
): () => void {
  let set = subscribers.get(projectId);
  if (!set) {
    set = new Set();
    subscribers.set(projectId, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set?.size === 0) subscribers.delete(projectId);
  };
}

function broadcast(projectId: string, session: PreviewSessionRow): void {
  const set = subscribers.get(projectId);
  if (!set) return;
  const event = { state: session.state, version: session.version, taskId: session.task_id, error: session.error };
  for (const cb of set) {
    try {
      cb(event);
    } catch {
      /* subscriber errors never break the stream */
    }
  }
}

/** Preview tooling available on THIS deployment (honest capability detection). */
export function previewConfigured(): boolean {
  return Boolean(env.PREVIEW_BUILD_ENABLED === 'true' && env.PREVIEW_BUILD_COMMAND);
}

export async function getPreview(userId: string, projectId: string): Promise<PreviewSessionRow> {
  await assertProject(userId, projectId);
  const rows = await queryMany<PreviewSessionRow>('SELECT * FROM preview_sessions WHERE project_id = $1', [projectId]);
  if (!rows[0]) {
    const id = newId('pvw');
    await pool.query(
      `INSERT INTO preview_sessions (id, owner_id, project_id, state) VALUES ($1,$2,$3,$4)`,
      [id, userId, projectId, previewConfigured() ? 'OFFLINE' : PreviewState.NOT_CONFIGURED],
    );
    return (await queryMany<PreviewSessionRow>('SELECT * FROM preview_sessions WHERE id = $1', [id]))[0]!;
  }
  return rows[0];
}

async function assertProject(userId: string, projectId: string): Promise<void> {
  const project = await queryOne<{ id: string }>('SELECT id FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [
    projectId,
    userId,
  ]);
  if (!project) throw AppError.notFound('Project');
}

/**
 * Request a build. Only runs when preview tooling is configured; otherwise the
 * session stays honestly NOT_CONFIGURED (never a fake READY).
 */
export async function requestBuild(userId: string, projectId: string, taskId?: string): Promise<PreviewSessionRow> {
  const session = await getPreview(userId, projectId);
  if (!previewConfigured()) {
    await pool.query(
      `UPDATE preview_sessions SET state = $2, error = $3 WHERE project_id = $1`,
      [projectId, PreviewState.NOT_CONFIGURED, 'Preview tooling is not configured on this deployment'],
    );
    const updated = (await queryMany<PreviewSessionRow>('SELECT * FROM preview_sessions WHERE project_id = $1', [projectId]))[0]!;
    broadcast(projectId, updated);
    return updated;
  }
  const isFresh = session.state === 'OFFLINE' || session.state === 'NOT_CONFIGURED';
  const next = isFresh ? PreviewState.BUILDING : PreviewState.UPDATING;
  const { capturePreviewSnapshot } = await import('./snapshots.js');
  await capturePreviewSnapshot(userId, projectId).catch(() => undefined);
  await pool.query(
    `UPDATE preview_sessions SET state = $2, task_id = $3, error = NULL, build_log = $4::jsonb, version = version + 1 WHERE project_id = $1`,
    [projectId, next, taskId ?? null, JSON.stringify([...session.build_log, `build requested (v${session.version + 1})`])],
  );
  const updated = (await queryMany<PreviewSessionRow>('SELECT * FROM preview_sessions WHERE project_id = $1', [projectId]))[0]!;
  broadcast(projectId, updated);
  await recordAudit({
    action: AuditAction.PREVIEW_BUILD_STARTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'preview_session',
    resourceId: session.id,
    detail: { projectId, taskId: taskId ?? null },
  });
  void runBuild(userId, projectId, session.id, updated.version).catch((err) => {
    logger.warn('preview build failed', { projectId, error: (err as Error).message });
  });
  return updated;
}

/**
 * Run the configured build command inside the project workspace. The build
 * output directory is strictly sandboxed (only files under it are served).
 */
async function runBuild(userId: string, projectId: string, sessionId: string, version: number): Promise<void> {
  const log = (line: string) => pool.query(`UPDATE preview_sessions SET build_log = build_log || $2::jsonb WHERE id = $1`, [sessionId, JSON.stringify([line.slice(0, 500)])]).catch(() => undefined);
  const projectRoot = env.PREVIEW_PROJECTS_ROOT ? path.resolve(env.PREVIEW_PROJECTS_ROOT, projectId) : null;
  if (!projectRoot) {
    await pool.query(`UPDATE preview_sessions SET state = $2, error = $3 WHERE id = $1`, [
      sessionId,
      PreviewState.ERROR,
      'PREVIEW_PROJECTS_ROOT is not configured',
    ]);
    await previewOutcome(userId, projectId, sessionId, false, 'PREVIEW_PROJECTS_ROOT is not configured');
    return;
  }
  try {
    await stat(projectRoot);
  } catch {
    await pool.query(`UPDATE preview_sessions SET state = $2, error = $3 WHERE id = $1`, [
      sessionId,
      PreviewState.ERROR,
      'project workspace not found on this deployment',
    ]);
    await previewOutcome(userId, projectId, sessionId, false, 'project workspace not found on this deployment');
    return;
  }
  const command = env.PREVIEW_BUILD_COMMAND!;
  await log(`> ${command}`);
  const result = await runCommand(command, projectRoot);
  for (const line of result.lines) await log(line);
  if (result.exitCode !== 0) {
    await pool.query(`UPDATE preview_sessions SET state = $2, error = $3 WHERE id = $1`, [
      sessionId,
      PreviewState.ERROR,
      `build failed (exit ${result.exitCode}): ${result.lines.slice(-2).join(' ').slice(0, 1000)}`,
    ]);
    await previewOutcome(userId, projectId, sessionId, false, `build failed (exit ${result.exitCode})`);
    return;
  }
  await pool.query(`UPDATE preview_sessions SET state = $2, error = NULL WHERE id = $1`, [sessionId, PreviewState.READY]);
  await previewOutcome(userId, projectId, sessionId, true);
}

async function runCommand(command: string, cwd: string): Promise<{ exitCode: number; lines: string[] }> {
  return new Promise((resolve) => {
    const [cmd, ...args] = command.split(/\s+/);
    const child = spawn(cmd ?? 'echo', args, {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    const lines: string[] = [];
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) lines.push(line);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', () => resolve({ exitCode: 1, lines }));
    const timer = setTimeout(() => child.kill(), 5 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, lines });
    });
  });
}

async function previewOutcome(userId: string, projectId: string, sessionId: string, ok: boolean, error?: string): Promise<void> {
  const rows = await queryMany<PreviewSessionRow>('SELECT * FROM preview_sessions WHERE id = $1', [sessionId]);
  const session = rows[0];
  if (session) {
    broadcast(projectId, session);
    const { capturePreviewSnapshot } = await import('./snapshots.js');
    await capturePreviewSnapshot(userId, projectId).catch(() => undefined);
    await recordAudit({
      action: ok ? AuditAction.PREVIEW_BUILD_SUCCEEDED : AuditAction.PREVIEW_BUILD_FAILED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'preview_session',
      resourceId: sessionId,
      detail: { projectId, error: error ?? null, version: session.version },
    });
    await notify(userId, ok ? NotificationType.PREVIEW_READY : NotificationType.PREVIEW_FAILED, ok ? 'Preview ready' : 'Preview build failed', {
      body: ok ? 'Your live preview is ready to view.' : error ?? 'The preview build failed.',
      resourceType: 'preview_session',
      resourceId: sessionId,
      metadata: { projectId },
    }).catch(() => undefined);
  }
}

/**
 * Called by the task engine when a task for a project reaches a terminal
 * state. If a preview session exists and preview tooling is configured, a
 * rebuild is queued (UPDATING) - otherwise the session stays honestly
 * NOT_CONFIGURED/OFFLINE. Never throws; never fabricates a build.
 */
export async function previewTaskCompleted(taskId: string, projectId: string): Promise<void> {
  try {
    const rows = await queryMany<PreviewSessionRow>('SELECT * FROM preview_sessions WHERE project_id = $1', [projectId]);
    const session = rows[0];
    if (!session) return;
    if (!previewConfigured()) return;
    if (session.state === 'READY' || session.state === 'ERROR' || session.state === 'UPDATING' || session.state === 'BUILDING') {
      await pool.query(
        `UPDATE preview_sessions SET state = $2, task_id = $3, error = NULL WHERE project_id = $1`,
        [projectId, PreviewState.UPDATING, taskId],
      );
      const updated = (await queryMany<PreviewSessionRow>('SELECT * FROM preview_sessions WHERE project_id = $1', [projectId]))[0]!;
      broadcast(projectId, updated);
      void runBuild(session.owner_id, projectId, session.id, updated.version).catch(() => undefined);
    }
  } catch {
    /* preview accounting is best-effort; never break task transitions */
  }
}

export async function markPreviewOffline(userId: string, projectId: string): Promise<PreviewSessionRow> {
  const session = await getPreview(userId, projectId);
  await pool.query(`UPDATE preview_sessions SET state = $2 WHERE id = $1`, [session.id, PreviewState.OFFLINE]);
  const updated = (await queryMany<PreviewSessionRow>('SELECT * FROM preview_sessions WHERE id = $1', [session.id]))[0]!;
  broadcast(projectId, updated);
  return updated;
}

/**
 * Serve the built index.html from the sandboxed output directory.
 * Returns null (NOT_CONFIGURED/ERROR) honestly — never fabricated content.
 */
export async function previewContent(userId: string, projectId: string): Promise<{ html: string; headers: Record<string, string> } | null> {
  const session = await getPreview(userId, projectId);
  if (session.state !== PreviewState.READY || !previewConfigured() || !env.PREVIEW_OUTPUT_DIR) return null;
  const outRoot = path.resolve(env.PREVIEW_OUTPUT_DIR, projectId);
  const indexPath = path.join(outRoot, 'index.html');
  try {
    const resolved = path.resolve(indexPath);
    if (!resolved.startsWith(path.resolve(env.PREVIEW_OUTPUT_DIR))) return null;
    const html = await readFile(resolved, 'utf-8');
    return {
      html,
      headers: {
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    };
  } catch {
    return null;
  }
}