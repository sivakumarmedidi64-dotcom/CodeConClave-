/**
 * CodeConClave — PKG-22 Advanced Code Workspace — multi-file state.
 * Persisted per (user, project) workspace editor state: open tabs, pinned,
 * order, split layout, active file, and per-tab saved cursor + unsaved flag for
 * restoration. Confined to a single workspace row per user+project.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { workspaceEnabled } from './config.js';
import { assertProjectAccess } from '../runtime/security.js';

export interface TabState {
  path: string;
  pinned: boolean;
  order: number;
  unsaved: boolean;
  savedSha256?: string | null;
  cursorLine?: number | null;
  cursorCol?: number | null;
}

export interface WorkspaceState {
  workspaceId: string;
  projectId: string;
  activePath: string | null;
  split: 'single' | 'split-vertical' | 'split-horizontal';
  tabs: TabState[];
}

async function ensureWorkspace(userId: string, projectId: string): Promise<{ id: string }> {
  if (!workspaceEnabled()) throw AppError.conflict('workspace_disabled', 'Advanced Code Workspace is disabled on this deployment');
  await assertProjectAccess(userId, projectId);
  return withTenant<{ id: string }>(userId, async (q) => {
    const existing = await q
      .query<{ id: string }>('SELECT id FROM workspaces WHERE user_id = $1 AND project_id = $2', [userId, projectId])
      .then((r) => r.rows[0] ?? null);
    if (existing) return existing;
    const id = newId(PREFIX.WORKSPACE_EDITOR);
    await q.query(
      'INSERT INTO workspaces (id, user_id, project_id) VALUES ($1,$2,$3)',
      [id, userId, projectId],
    );
    return { id };
  });
}

export async function getWorkspace(userId: string, projectId: string): Promise<WorkspaceState> {
  const ws = await ensureWorkspace(userId, projectId);
  const [tabs, row] = await withTenant<
    [
      Array<{
        path: string;
        pinned: boolean;
        tab_order: number;
        unsaved: boolean;
        saved_sha256: string | null;
        cursor_line: number | null;
        cursor_col: number | null;
      }>,
      { active_path: string | null; split: string } | null,
    ]
  >(userId, (q) =>
    Promise.all([
      q
        .query<{
          path: string;
          pinned: boolean;
          tab_order: number;
          unsaved: boolean;
          saved_sha256: string | null;
          cursor_line: number | null;
          cursor_col: number | null;
        }>(
          'SELECT path, pinned, tab_order, unsaved, saved_sha256, cursor_line, cursor_col FROM workspace_tabs WHERE workspace_id = $1 ORDER BY tab_order',
          [ws.id],
        )
        .then((r) => r.rows),
      q
        .query<{ active_path: string | null; split: string }>('SELECT active_path, split FROM workspaces WHERE id = $1', [ws.id])
        .then((r) => r.rows[0] ?? null),
    ]),
  );
  return {
    workspaceId: ws.id,
    projectId,
    activePath: row?.active_path ?? null,
    split: (row?.split as WorkspaceState['split']) ?? 'single',
    tabs: tabs.map((t) => ({
      path: t.path,
      pinned: t.pinned,
      order: Number(t.tab_order),
      unsaved: t.unsaved,
      savedSha256: t.saved_sha256,
      cursorLine: t.cursor_line === null ? null : Number(t.cursor_line),
      cursorCol: t.cursor_col === null ? null : Number(t.cursor_col),
    })),
  };
}

export async function restoreState(userId: string, projectId: string): Promise<WorkspaceState> {
  return getWorkspace(userId, projectId);
}

export async function setSplit(userId: string, projectId: string, split: WorkspaceState['split']): Promise<WorkspaceState> {
  const ws = await ensureWorkspace(userId, projectId);
  if (!['single', 'split-vertical', 'split-horizontal'].includes(split)) {
    throw AppError.badRequest('invalid_split', 'split must be single, split-vertical, or split-horizontal');
  }
  await withTenant(userId, (q) => q.query('UPDATE workspaces SET split = $2 WHERE id = $1', [ws.id, split]));
  return getWorkspace(userId, projectId);
}

export async function setActiveFile(userId: string, projectId: string, relPath: string, cursor?: { line?: number; col?: number }): Promise<WorkspaceState> {
  const ws = await ensureWorkspace(userId, projectId);
  await withTenant(userId, async (q) => {
    await q.query('UPDATE workspaces SET active_path = $2 WHERE id = $1', [ws.id, relPath]);
    if (cursor && cursor.line !== undefined) {
      await q.query(
        'UPDATE workspace_tabs SET cursor_line = $3, cursor_col = $4 WHERE workspace_id = $1 AND path = $2',
        [ws.id, relPath, cursor.line, cursor.col ?? 0],
      );
    }
  });
  return getWorkspace(userId, projectId);
}

export async function openTab(userId: string, projectId: string, relPath: string, opts?: { pinned?: boolean }): Promise<WorkspaceState> {
  const ws = await ensureWorkspace(userId, projectId);
  await withTenant(userId, async (q) => {
    const existing = await q
      .query<{ id: string }>('SELECT id FROM workspace_tabs WHERE workspace_id = $1 AND path = $2', [ws.id, relPath])
      .then((r) => r.rows[0] ?? null);
    if (!existing) {
      const maxOrder = await q
        .query<{ m: string }>('SELECT COALESCE(MAX(tab_order),0)::text AS m FROM workspace_tabs WHERE workspace_id = $1', [ws.id])
        .then((r) => r.rows[0] ?? null);
      const order = Number(maxOrder?.m ?? 0) + 1;
      const id = newId(PREFIX.WORKSPACE_TAB);
      await q.query(
        'INSERT INTO workspace_tabs (id, workspace_id, path, pinned, tab_order) VALUES ($1,$2,$3,$4,$5)',
        [id, ws.id, relPath, Boolean(opts?.pinned), order],
      );
    }
    await q.query('UPDATE workspaces SET active_path = $2 WHERE id = $1', [ws.id, relPath]);
  });
  return getWorkspace(userId, projectId);
}

export async function closeTab(userId: string, projectId: string, relPath: string): Promise<WorkspaceState> {
  const ws = await ensureWorkspace(userId, projectId);
  await withTenant(userId, (q) => q.query('DELETE FROM workspace_tabs WHERE workspace_id = $1 AND path = $2', [ws.id, relPath]));
  return getWorkspace(userId, projectId);
}

export async function setTabUnsaved(userId: string, projectId: string, relPath: string, unsaved: boolean, savedSha256?: string | null): Promise<void> {
  const ws = await ensureWorkspace(userId, projectId);
  await withTenant(userId, (q) =>
    q.query(
      'UPDATE workspace_tabs SET unsaved = $3, saved_sha256 = $4 WHERE workspace_id = $1 AND path = $2',
      [ws.id, relPath, unsaved, savedSha256 ?? null],
    ),
  );
}

export async function recentWorkspaceFiles(userId: string): Promise<string[]> {
  if (!workspaceEnabled()) return [];
  const rows = await withTenant<Array<{ path: string; project_id: string }>>(userId, (q) =>
    q
      .query<{ path: string; project_id: string }>(
        `SELECT t.path, t.workspace_id FROM workspace_tabs t
           JOIN workspaces w ON w.id = t.workspace_id
          WHERE w.user_id = $1 ORDER BY t.updated_at DESC LIMIT 25`,
        [userId],
      )
      .then((r) => r.rows),
  );
  return rows.map((r) => r.path);
}
