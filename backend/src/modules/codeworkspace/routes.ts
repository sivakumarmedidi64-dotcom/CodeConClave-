/**
 * CodeConClave — PKG-22 Advanced Code Workspace — routes (/api/v1/codeworkspace).
 * Authenticated + project-owned. Every read/write is path-confined to the
 * project runtime workspace root; protected/secret paths are blocked. All
 * capability-gated by AIOS_P2_WORKSPACE (default OFF).
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { workspaceCapabilities } from './service.js';
import { assertProjectAccess } from '../runtime/security.js';
import { workspaceEnabled } from './config.js';
import {
  listTree, listFilePaths, readFileEntry, writeFileEntry,
} from './fs.js';
import {
  getWorkspace, restoreState, setSplit, setActiveFile, openTab, closeTab, recentWorkspaceFiles,
} from './state.js';
import { searchWorkspace, searchCurrentFile, fetchContext } from './search.js';
import { getOutline, findDefinition, findReferences, findImportRelations } from './symbols.js';
import {
  createReview, decideFile, acceptAll, rejectAll, applyReview, getReview, listReviews, recordDirectEdit, listEditHistory,
} from './edit.js';
import { materializeRenamePreview, executeRename, applyRenameReview } from './refactor.js';
import { detectAffectedFiles } from './related.js';
import { buildEditorContext } from './context.js';
import { gitStatus } from './git.js';
import { getFileDiagnostics } from './diagnostics.js';
import { workspaceMemoryContext } from './memory.js';

function projectIdFrom(req: import('express').Request): string {
  const viaQuery = req.query.projectId;
  const viaBody = (req.body as { projectId?: unknown } | undefined)?.projectId;
  const pid = typeof viaQuery === 'string' ? viaQuery : typeof viaBody === 'string' ? viaBody : '';
  if (!pid) throw AppError.badRequest('project_required', 'projectId is required');
  return pid;
}

function requireEnabled(): void {
  if (!workspaceEnabled()) throw AppError.conflict('workspace_disabled', 'Advanced Code Workspace is disabled on this deployment');
}

function boolStr(v: unknown): boolean {
  return String(v ?? '') === 'true';
}
function numOpt(req: import('express').Request, key: string): number | undefined {
  const v = req.query[key];
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export const codeWorkspaceRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);
  const uid = (req: import('express').Request): string => req.ctx.user!.id;

  router.get('/capabilities', asyncRoute(async (req, res) => {
    const pid = projectIdFrom(req);
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ capabilities: workspaceCapabilities(pid, uid(req)) }));
  }));

  // ------------------------------------------------------------- file tree / paths
  router.get('/tree', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const uid_ = uid(req);
    await assertProjectAccess(uid_, pid);
    const tree = await listTree(pid);
    if (tree === null) throw AppError.conflict('workspace_unavailable', 'Workspace is not available on this deployment');
    res.json(jsonResult({ tree }));
  }));

  router.get('/paths', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    await assertProjectAccess(uid(req), pid);
    const paths = await listFilePaths(pid);
    if (paths === null) throw AppError.conflict('workspace_unavailable', 'Workspace is not available on this deployment');
    res.json(jsonResult({ paths }));
  }));

  // ------------------------------------------------------------- read / write file
  router.get('/file', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const rel = String(req.query.path ?? '');
    if (!rel) throw AppError.badRequest('path_required', 'path is required');
    await assertProjectAccess(uid(req), pid);
    const file = await readFileEntry(pid, rel);
    if (!file) throw AppError.conflict('workspace_unavailable', 'Workspace is not available on this deployment');
    res.json(jsonResult({ file }));
  }));

  router.post('/file/save', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const uid_ = uid(req);
    await assertProjectAccess(uid_, pid);
    const rel = String((req.body as { path?: unknown })?.path ?? '');
    const content = String((req.body as { content?: unknown })?.content ?? '');
    const baseSha = (req.body as { baseSha256?: unknown })?.baseSha256;
    if (!rel) throw AppError.badRequest('path_required', 'path is required');
    const newSha = await writeFileEntry(pid, rel, content, typeof baseSha === 'string' ? baseSha : undefined);
    const record = await recordDirectEdit(uid_, pid, rel, typeof baseSha === 'string' ? baseSha : newSha, content);
    res.json(jsonResult({ sha256: newSha, editId: record.id }));
  }));

  // ------------------------------------------------------------- multi-file workspace state
  router.get('/state', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ state: await getWorkspace(uid(req), pid) }));
  }));

  router.get('/restore', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ state: await restoreState(uid(req), pid) }));
  }));

  router.post('/state/split', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    await assertProjectAccess(uid(req), pid);
    const split = String((req.body as { split?: unknown })?.split ?? 'single');
    res.json(jsonResult({ state: await setSplit(uid(req), pid, split as never) }));
  }));

  router.post('/state/active', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const rel = String((req.body as { path?: unknown })?.path ?? '');
    const cursor = (req.body as { cursor?: { line?: number; col?: number } })?.cursor;
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ state: await setActiveFile(uid(req), pid, rel, cursor) }));
  }));

  router.post('/tab/open', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const rel = String((req.body as { path?: unknown })?.path ?? '');
    const pinned = boolStr((req.body as { pinned?: unknown })?.pinned);
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ state: await openTab(uid(req), pid, rel, { pinned }) }));
  }));

  router.post('/tab/close', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const rel = String((req.body as { path?: unknown })?.path ?? '');
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ state: await closeTab(uid(req), pid, rel) }));
  }));

  router.get('/recent', asyncRoute(async (req, res) => {
    requireEnabled();
    res.json(jsonResult({ files: await recentWorkspaceFiles(uid(req)) }));
  }));

  // ------------------------------------------------------------- search
  router.get('/search', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    await assertProjectAccess(uid(req), pid);
    const q = String(req.query.q ?? '');
    const result = await searchWorkspace(pid, {
      q,
      regex: boolStr(req.query.regex),
      caseSensitive: boolStr(req.query.caseSensitive),
      context: numOpt(req, 'context'),
      limit: numOpt(req, 'limit'),
      pathFilter: String(req.query.pathFilter ?? '') || undefined,
    });
    if (result === null) throw AppError.conflict('workspace_unavailable', 'Workspace is not available on this deployment');
    res.json(jsonResult({ ...result }));
  }));

  router.get('/search/file', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const rel = String(req.query.path ?? '');
    if (!rel) throw AppError.badRequest('path_required', 'path is required');
    await assertProjectAccess(uid(req), pid);
    const result = await searchCurrentFile(pid, rel, {
      q: String(req.query.q ?? ''),
      regex: boolStr(req.query.regex),
      caseSensitive: boolStr(req.query.caseSensitive),
      context: numOpt(req, 'context'),
    });
    if (result === null) throw AppError.conflict('workspace_unavailable', 'Workspace is not available on this deployment');
    res.json(jsonResult({ ...result }));
  }));

  router.get('/search/context', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const rel = String(req.query.path ?? '');
    const line = Number(req.query.line ?? 1);
    const ctx = numOpt(req, 'context') ?? 2;
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ context: await fetchContext(pid, rel, line, ctx) }));
  }));

  // ------------------------------------------------------------- symbols
  router.get('/symbols/outline', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const rel = String(req.query.path ?? '');
    if (!rel) throw AppError.badRequest('path_required', 'path is required');
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ outline: await getOutline(pid, rel) }));
  }));

  router.get('/symbols/definition', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const symbol = String(req.query.symbol ?? '');
    const rel = String(req.query.path ?? '') || undefined;
    if (!symbol) throw AppError.badRequest('symbol_required', 'symbol is required');
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ definition: await findDefinition(pid, symbol, rel) }));
  }));

  router.get('/symbols/references', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const symbol = String(req.query.symbol ?? '');
    if (!symbol) throw AppError.badRequest('symbol_required', 'symbol is required');
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ references: await findReferences(pid, symbol) }));
  }));

  router.get('/symbols/imports', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const rel = String(req.query.path ?? '');
    if (!rel) throw AppError.badRequest('path_required', 'path is required');
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ imports: await findImportRelations(pid, rel) }));
  }));

  // ------------------------------------------------------------- related files (cross-file)
  router.get('/related', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const rel = String(req.query.path ?? '');
    const hint = String(req.query.symbol ?? '') || undefined;
    if (!rel) throw AppError.badRequest('path_required', 'path is required');
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ affected: await detectAffectedFiles(pid, rel, hint) }));
  }));

  // ------------------------------------------------------------- diagnostics
  router.get('/diagnostics', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const rel = String(req.query.path ?? '');
    await assertProjectAccess(uid(req), pid);
    const d = await getFileDiagnostics(uid(req), pid, rel);
    res.json(jsonResult(d));
  }));

  // ------------------------------------------------------------- memory
  router.get('/memory', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult(await workspaceMemoryContext(uid(req), pid)));
  }));

  // ------------------------------------------------------------- AI editor context
  router.get('/context', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const rel = String(req.query.path ?? '');
    const line = numOpt(req, 'line');
    const col = numOpt(req, 'col');
    if (!rel) throw AppError.badRequest('path_required', 'path is required');
    await assertProjectAccess(uid(req), pid);
    const ctx = await buildEditorContext(uid(req), pid, rel, line, col);
    res.json(jsonResult({ context: ctx }));
  }));

  // ------------------------------------------------------------- git
  router.get('/git', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ git: await gitStatus(pid) }));
  }));

  // ------------------------------------------------------------- reviews (B1-style workspace review)
  router.post('/review', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const uid_ = uid(req);
    await assertProjectAccess(uid_, pid);
    const files = (req.body as { files?: unknown })?.files;
    const title = (req.body as { title?: unknown })?.title;
    if (!Array.isArray(files) || files.length === 0) throw AppError.badRequest('files_required', 'files[] is required');
    const parsed = (files as Array<{ path?: unknown; baseContent?: unknown; proposedContent?: unknown }>).map((f) => ({
      path: String(f.path ?? ''),
      baseContent: String(f.baseContent ?? ''),
      proposedContent: String(f.proposedContent ?? ''),
    }));
    const view = await createReview(uid_, pid, parsed, typeof title === 'string' ? title : undefined);
    res.status(201).json(jsonResult({ review: view }));
  }));

  router.get('/review', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    await assertProjectAccess(uid(req), pid);
    const reviewId = String(req.query.id ?? '');
    if (reviewId) return res.json(jsonResult({ review: await getReview(uid(req), pid, reviewId) }));
    res.json(jsonResult({ reviews: await listReviews(uid(req), pid) }));
  }));

  router.post('/review/:id/accept-all', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ review: await acceptAll(uid(req), pid, req.params.id!) }));
  }));

  router.post('/review/:id/reject-all', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ review: await rejectAll(uid(req), pid, req.params.id!) }));
  }));

  router.post('/review/:id/apply', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ review: await applyReview(uid(req), pid, req.params.id!) }));
  }));

  router.post('/review/:id/decide', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const rel = String((req.body as { path?: unknown })?.path ?? '');
    const accepted = boolStr((req.body as { accepted?: unknown })?.accepted);
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ review: await decideFile(uid(req), pid, req.params.id!, rel, accepted) }));
  }));

  // ------------------------------------------------------------- refactoring (safe rename)
  router.post('/refactor/rename/preview', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const uid_ = uid(req);
    await assertProjectAccess(uid_, pid);
    const symbol = String((req.body as { symbol?: unknown })?.symbol ?? '');
    const newName = String((req.body as { newName?: unknown })?.newName ?? '');
    if (!symbol || !newName) throw AppError.badRequest('refactor_input_required', 'symbol and newName are required');
    res.json(jsonResult({ plan: await materializeRenamePreview(uid_, pid, symbol, newName) }));
  }));

  router.post('/refactor/rename', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const uid_ = uid(req);
    await assertProjectAccess(uid_, pid);
    const symbol = String((req.body as { symbol?: unknown })?.symbol ?? '');
    const newName = String((req.body as { newName?: unknown })?.newName ?? '');
    if (!symbol || !newName) throw AppError.badRequest('refactor_input_required', 'symbol and newName are required');
    const out = await executeRename(uid_, pid, symbol, newName);
    res.json(jsonResult(out));
  }));

  router.post('/refactor/review/:id/apply', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult(await applyRenameReview(uid(req), pid, req.params.id!)));
  }));

  // ------------------------------------------------------------- edit history
  router.get('/edits', asyncRoute(async (req, res) => {
    requireEnabled();
    const pid = projectIdFrom(req);
    const rel = String(req.query.path ?? '') || undefined;
    const limit = numOpt(req, 'limit');
    await assertProjectAccess(uid(req), pid);
    res.json(jsonResult({ edits: await listEditHistory(uid(req), pid, rel, limit) }));
  }));

  return router;
};