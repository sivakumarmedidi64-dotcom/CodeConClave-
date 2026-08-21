/**
 * CodeConClave — files routes (Phase 8).
 * Multipart upload (multer in-memory), metadata, versions, rollback,
 * references, permissions, trash lifecycle. All routes require auth.
 * Responses are serialized to the wire shape the frontend consumes
 * (snake_case DB rows, FileRef-compatible).
 */
import { Router } from 'express';
import multer from 'multer';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import type { FileView, VersionView } from './service.js';
import {
  uploadFile,
  getFile,
  getFileContent,
  listFiles,
  fileTree,
  favoriteFiles,
  recentFiles,
  trashFiles,
  fileVersions,
  restoreFileVersion,
  setFileTags,
  setFileCategory,
  toggleFavorite,
  addFileReference,
  setFilePermission,
  softDeleteFile,
  restoreFile,
  restoreFilesBulk,
  softDeleteFilesBulk,
  permanentDeleteFile,
  purgeFilesBulk,
  purgeExpiredTrash,
  searchProjectFiles,
  listFileReferences,
  listFileActivity,
} from './service.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 20 },
});

/**
 * Content types that are safe to render inline in the browser when the app
 * itself navigates to a file's content URL. Everything else is served as a
 * download: client-controlled MIME (e.g. text/html, image/svg+xml,
 * text/javascript) must never be rendered from the app origin, or an uploaded
 * file becomes a stored-XSS carrier.
 */
export function safeInlineMime(mime: string): boolean {
  if (mime.startsWith('image/')) return mime !== 'image/svg+xml';
  return ['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json'].includes(mime);
}

function toRowShape(v: FileView): Record<string, unknown> {
  return {
    id: v.id,
    project_id: v.projectId,
    owner_id: v.ownerId,
    path: v.path,
    size_bytes: v.sizeBytes,
    sha256: v.sha256,
    storage_key: v.storageKey,
    storage_provider: v.storageProvider,
    mime_type: v.mimeType,
    is_directory: v.isDirectory,
    tags: v.tags,
    category: v.category,
    description: v.description,
    is_favorite: v.isFavorite,
    preview_kind: v.previewKind,
    preview_status: v.previewStatus,
    ocr_status: v.ocrStatus,
    encrypted: v.encrypted,
    deleted_at: v.deletedAt ?? null,
    created_at: v.createdAt,
    updated_at: v.updatedAt,
  };
}

function toVersionRows(rows: VersionView[]): Record<string, unknown>[] {
  return rows.map((r) => ({
    id: r.id,
    file_id: r.fileId,
    version: r.version,
    sha256: r.contentSha256,
    size_bytes: r.sizeBytes,
    reason: r.changeReason,
    created_by: r.createdBy,
    parent_version: r.parentVersion,
    rollback_reference: r.rollbackReference,
    created_at: r.createdAt,
  }));
}

export const fileRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  const userId = (req: { ctx: { user?: { id: string } | null } }): string => req.ctx.user!.id;

  // ---------------------------------------------------------------- listing
  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const files = await listFiles(userId(req), projectId);
      res.json(jsonResult({ files: files.map(toRowShape) }));
    }),
  );

  router.get(
    '/search',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      const q = String(req.query.q ?? '');
      if (!projectId || !q) throw AppError.badRequest('invalid_input', 'projectId and q are required');
      const files = await searchProjectFiles(userId(req), projectId, q);
      res.json(jsonResult({ files: files.map(toRowShape) }));
    }),
  );

  router.get(
    '/tree',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      res.json(jsonResult({ tree: await fileTree(userId(req), projectId) }));
    }),
  );

  router.get(
    '/recent',
    asyncRoute(async (req, res) => {
      const files = await recentFiles(userId(req));
      res.json(jsonResult({ files: files.map(toRowShape) }));
    }),
  );

  router.get(
    '/favorites',
    asyncRoute(async (req, res) => {
      const files = await favoriteFiles(userId(req));
      res.json(jsonResult({ files: files.map(toRowShape) }));
    }),
  );

  router.get(
    '/trash',
    asyncRoute(async (req, res) => {
      const files = await trashFiles(userId(req));
      res.json(jsonResult({ files: files.map(toRowShape) }));
    }),
  );

  // ---------------------------------------------------------------- bulk trash (must precede /:id)
  router.post(
    '/restore-bulk',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      const ids = req.body?.ids;
      if (!projectId || !Array.isArray(ids)) throw AppError.badRequest('invalid_input', 'projectId and ids are required');
      res.json(jsonResult({ restored: await restoreFilesBulk(userId(req), projectId, ids as string[]) }));
    }),
  );

  router.post(
    '/purge-bulk',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      const ids = req.body?.ids;
      if (!projectId || !Array.isArray(ids)) throw AppError.badRequest('invalid_input', 'projectId and ids are required');
      res.json(jsonResult({ purged: await purgeFilesBulk(userId(req), projectId, ids as string[]) }));
    }),
  );

  router.post(
    '/trash/soft-delete',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      const ids = req.body?.ids;
      if (!projectId || !Array.isArray(ids)) throw AppError.badRequest('invalid_input', 'projectId and ids are required');
      res.json(jsonResult({ trashed: await softDeleteFilesBulk(userId(req), projectId, ids as string[]) }));
    }),
  );

  router.post(
    '/purge-expired',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ purged: await purgeExpiredTrash(userId(req)) }));
    }),
  );

  // ---------------------------------------------------------------- upload
  router.post(
    '/upload',
    upload.array('files', 20),
    asyncRoute(async (req, res) => {
      if (!req.files || (Array.isArray(req.files) && req.files.length === 0)) {
        throw AppError.badRequest('file_required', 'Multipart field "files" is required');
      }
      const projectId = String(req.body?.projectId ?? '');
      if (!projectId) throw AppError.badRequest('invalid_input', 'projectId is required');
      const raw = req.files as Express.Multer.File[] | Record<string, Express.Multer.File[]> | undefined;
      const uploaded: Express.Multer.File[] = Array.isArray(raw)
        ? raw
        : Object.values(raw ?? {}).flat();
      const rows: Record<string, unknown>[] = [];
      for (const file of uploaded) {
        const path = String(req.body?.path ?? file.originalname);
        const tags = Array.isArray(req.body?.tags) ? (req.body.tags as string[]) : [];
        const view = await uploadFile(userId(req), projectId, path, file.buffer, file.mimetype, {
          tags,
          category: req.body?.category ? String(req.body.category) : undefined,
          description: req.body?.description ? String(req.body.description) : undefined,
        });
        rows.push(toRowShape(view));
      }
      res.status(201).json(jsonResult({ files: rows }));
    }),
  );

  // ---------------------------------------------------------------- single file
  router.get(
    '/:id',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const file = await getFile(userId(req), projectId, req.params.id!);
      res.json(jsonResult({ file: toRowShape(file) }));
    }),
  );

  router.get(
    '/:id/content',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const content = await getFileContent(userId(req), projectId, req.params.id!);
      const mime = content.mimeType ?? 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      const disposition = safeInlineMime(mime) ? 'inline' : 'attachment';
      res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(content.name)}"`);
      res.send(content.buffer);
    }),
  );

  router.get(
    '/:id/versions',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const versions = await fileVersions(userId(req), projectId, req.params.id!);
      res.json(jsonResult({ versions: toVersionRows(versions) }));
    }),
  );

  router.get(
    '/:id/references',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      res.json(jsonResult({ references: await listFileReferences(userId(req), projectId, req.params.id!) }));
    }),
  );

  router.get(
    '/:id/activity',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      res.json(jsonResult({ activity: await listFileActivity(userId(req), projectId, req.params.id!) }));
    }),
  );

  router.post(
    '/:id/restore-version',
    asyncRoute(async (req, res) => {
      const projectId = String(req.body?.projectId ?? '');
      const version = Number(req.body?.version);
      if (!projectId || !Number.isInteger(version) || version < 1) {
        throw AppError.badRequest('invalid_input', 'projectId and a positive version are required');
      }
      await restoreFileVersion(userId(req), projectId, req.params.id!, version);
      const file = await getFile(userId(req), projectId, req.params.id!);
      res.json(jsonResult({ file: toRowShape(file) }));
    }),
  );

  // ---------------------------------------------------------------- metadata (frontend uses POST /:id/<field>)
  router.post(
    '/:id/favorite',
    asyncRoute(async (req, res) => {
      const projectId = String(req.body?.projectId ?? '');
      const favorite = Boolean(req.body?.favorite);
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const file = await toggleFavorite(userId(req), projectId, req.params.id!, favorite);
      res.json(jsonResult({ file: toRowShape(file) }));
    }),
  );

  router.post(
    '/:id/tags',
    asyncRoute(async (req, res) => {
      const projectId = String(req.body?.projectId ?? '');
      if (!projectId || !Array.isArray(req.body?.tags)) {
        throw AppError.badRequest('invalid_input', 'projectId and tags are required');
      }
      const file = await setFileTags(userId(req), projectId, req.params.id!, req.body.tags as string[]);
      res.json(jsonResult({ file: toRowShape(file) }));
    }),
  );

  router.post(
    '/:id/category',
    asyncRoute(async (req, res) => {
      const projectId = String(req.body?.projectId ?? '');
      if (!projectId || req.body?.category === undefined) {
        throw AppError.badRequest('invalid_input', 'projectId and category are required');
      }
      const file = await setFileCategory(userId(req), projectId, req.params.id!, String(req.body.category));
      res.json(jsonResult({ file: toRowShape(file) }));
    }),
  );

  router.patch(
    '/:id',
    asyncRoute(async (req, res) => {
      const projectId = String(req.body?.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const id = req.params.id!;
      const uid = userId(req);
      let file;
      if (req.body?.tags !== undefined) file = await setFileTags(uid, projectId, id, req.body.tags);
      if (req.body?.category !== undefined) file = await setFileCategory(uid, projectId, id, String(req.body.category));
      if (req.body?.favorite !== undefined) file = await toggleFavorite(uid, projectId, id, Boolean(req.body.favorite));
      res.json(jsonResult({ file: file ? toRowShape(file) : null }));
    }),
  );

  router.post(
    '/:id/references',
    asyncRoute(async (req, res) => {
      const { projectId, refType, refId } = req.body ?? {};
      if (!projectId || !refType || !refId) {
        throw AppError.badRequest('invalid_input', 'projectId, refType and refId are required');
      }
      await addFileReference(userId(req), String(projectId), req.params.id!, String(refType), String(refId));
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.post(
    '/:id/permissions',
    asyncRoute(async (req, res) => {
      const { projectId, permission, granteeUserId, granted } = req.body ?? {};
      if (!projectId || !permission || !granteeUserId || granted === undefined) {
        throw AppError.badRequest('invalid_input', 'projectId, permission, granteeUserId and granted are required');
      }
      await setFilePermission(userId(req), String(projectId), req.params.id!, String(permission), String(granteeUserId), Boolean(granted));
      res.json(jsonResult({ ok: true }));
    }),
  );

  // ---------------------------------------------------------------- trash lifecycle
  router.post(
    '/:id/trash',
    asyncRoute(async (req, res) => {
      const projectId = String(req.body?.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const file = await softDeleteFile(userId(req), projectId, req.params.id!);
      res.json(jsonResult({ file: toRowShape(file) }));
    }),
  );

  router.post(
    '/:id/restore',
    asyncRoute(async (req, res) => {
      const projectId = String(req.body?.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const file = await restoreFile(userId(req), projectId, req.params.id!);
      res.json(jsonResult({ file: toRowShape(file) }));
    }),
  );

  router.delete(
    '/:id/permanent',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      await permanentDeleteFile(userId(req), projectId, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.delete(
    '/:id',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const permanent = req.query.permanent === 'true';
      if (permanent) {
        await permanentDeleteFile(userId(req), projectId, req.params.id!);
        res.json(jsonResult({ ok: true }));
        return;
      }
      const file = await softDeleteFile(userId(req), projectId, req.params.id!);
      res.json(jsonResult({ file: toRowShape(file) }));
    }),
  );

  return router;
};