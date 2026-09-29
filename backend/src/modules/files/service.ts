/**
 * CodeConClave — files module (Phase 8).
 * Real file subsystem: upload (new + overwrite versioning), path security,
 * protected-resource policy, blocked MIME/extension policy, at-rest
 * encryption (honest), preview metadata (OCR never faked), versions +
 * rollback with hash verification, references, permissions, folder tree,
 * favorites, recent, trash lifecycle (30-day recovery) and expiry purge.
 * Storage is provider-agnostic (local memory / S3-compatible / R2-deferred).
 */
import { pool, withTenant, withSystem, type DbQueryable } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { env } from '../../config/env.js';
import { sha256Hex, encryptBuffer, decryptBuffer } from '../../shared/crypto.js';
import { storage, storageEncryptionEnabled } from '../../integrations/storage.js';
import { recordAudit } from '../audit/service.js';
import { incrementUsage } from '../workspace/service.js';
import { getProject } from '../projects/service.js';
import {
  AuditAction,
  FileRetention,
  OcrStatus,
  PreviewKind,
  PreviewStatus,
} from '@codeconclave/shared';

/**
 * P0-2 Path 1: every query in this module runs on a tenant- or system-scoped
 * client (`q`) obtained from `withTenant(userId, ...)` / `withSystem(...)`.
 * File tenancy is project-scoped: membership is proven once by `getProject`
 * before the transaction, and `assertFileAccess` re-checks owner / member /
 * explicit grant on the same scoped connection the statements run on. The
 * authenticated principal is the only tenant key ever used.
 */
type Q = DbQueryable;

// ---------------------------------------------------------------- security policy

const PROTECTED_BASENAMES = new Set([
  '.env',
  '.netrc',
  '.htpasswd',
  '.pgpass',
  '.npmrc',
  '.pypirc',
  'secrets.json',
  'credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_ed448',
]);

const PROTECTED_SUFFIXES = ['.env.', '.env'] as const;

const PROTECTED_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx', 'ppk', 'p8']);

const BLOCKED_EXTENSIONS = new Set([
  'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'pif', 'msi', 'msix', 'appx',
  'jar', 'class', 'apk', 'dmg', 'deb', 'rpm', 'ps1', 'vbs', 'ocx', 'sys',
]);

const BLOCKED_MIMES = new Set([
  'application/x-msdownload',
  'application/x-dosexec',
  'application/x-executable',
  'application/vnd.microsoft.portable-executable',
  'application/x-msdos-program',
]);

const MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown',
  txt: 'text/plain', log: 'text/plain', conf: 'text/plain', ini: 'text/plain',
  json: 'application/json',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', jsx: 'text/javascript',
  ts: 'text/typescript', tsx: 'text/typescript', mts: 'text/typescript', cts: 'text/typescript',
  py: 'text/x-python', rb: 'text/x-ruby', go: 'text/x-go', rs: 'text/x-rust',
  c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-cpp', hpp: 'text/x-cpp', cc: 'text/x-cpp',
  java: 'text/x-java', php: 'text/x-php', sh: 'text/x-shellscript', bash: 'text/x-shellscript',
  yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/toml',
  csv: 'text/csv', html: 'text/html', htm: 'text/html', css: 'text/css', xml: 'application/xml',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  pdf: 'application/pdf',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'py', 'rb', 'go', 'rs',
  'c', 'h', 'cpp', 'hpp', 'cc', 'java', 'php', 'sh', 'bash', 'yml', 'yaml',
  'toml', 'html', 'htm', 'css', 'xml', 'sql', 'kt', 'kts', 'swift', 'scala', 'lua',
]);

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;
const REFERENCE_TYPES = new Set(['memory', 'dna', 'message', 'task', 'artifact', 'conversation']);
const PERMISSION_VALUES = new Set(['read', 'write', 'delete']);

export const FILE_STORAGE_PREFIX = 'codeconclave';

// ---------------------------------------------------------------- path security

/**
 * Normalize a client-supplied path: forward slashes, collapse runs, strip a
 * leading slash, drop "." segments and empty segments. Any ".." segment makes
 * the whole path invalid (returns ''). Whitespace-only paths normalize to ''.
 */
export function normalizePath(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  const cleaned = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '').trim();
  const segments = cleaned.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) return '';
  return segments.join('/');
}

function basenameOf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? '';
}

function extensionOf(path: string): string {
  const base = basenameOf(path).toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1) : '';
}

function isProtectedName(path: string): boolean {
  const base = basenameOf(path).toLowerCase();
  if (PROTECTED_BASENAMES.has(base)) return true;
  if (PROTECTED_SUFFIXES.some((s) => base.startsWith(s))) return true;
  if (PROTECTED_EXTENSIONS.has(extensionOf(path))) return true;
  return false;
}

function isBlockedExtension(path: string): boolean {
  return BLOCKED_EXTENSIONS.has(extensionOf(path));
}

function isBlockedMime(mime: string | undefined | null): boolean {
  return mime !== undefined && mime !== null && BLOCKED_MIMES.has(mime.toLowerCase());
}

function inferMime(path: string, provided: string | undefined): string {
  if (provided && provided.trim().length > 0) return provided.trim().toLowerCase();
  return MIME_BY_EXT[extensionOf(path)] ?? 'application/octet-stream';
}

function previewFor(mime: string, path: string): { kind: PreviewKind; status: PreviewStatus } {
  const ext = extensionOf(path);
  if (mime === 'text/markdown' || ext === 'md' || ext === 'markdown') {
    return { kind: PreviewKind.MARKDOWN, status: PreviewStatus.AVAILABLE };
  }
  if (mime === 'application/json' || ext === 'json') {
    return { kind: PreviewKind.JSON, status: PreviewStatus.AVAILABLE };
  }
  if (mime.startsWith('text/') || mime.includes('javascript') || mime.includes('typescript') || CODE_EXTENSIONS.has(ext)) {
    return { kind: PreviewKind.CODE, status: PreviewStatus.AVAILABLE };
  }
  if (mime.startsWith('image/')) return { kind: PreviewKind.IMAGE, status: PreviewStatus.UNAVAILABLE };
  if (mime === 'application/pdf') return { kind: PreviewKind.PDF, status: PreviewStatus.UNAVAILABLE };
  return { kind: PreviewKind.UNKNOWN, status: PreviewStatus.UNAVAILABLE };
}

function cleanTags(tags: string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const raw of tags) {
    const tag = String(raw ?? '').trim();
    if (!tag) continue;
    const capped = tag.length > MAX_TAG_LENGTH ? tag.slice(0, MAX_TAG_LENGTH) : tag;
    if (!out.includes(capped)) out.push(capped);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// ---------------------------------------------------------------- rows

export interface FileRow {
  id: string;
  project_id: string;
  owner_id: string;
  path: string;
  size_bytes: number;
  sha256: string;
  storage_key: string | null;
  storage_provider: string | null;
  mime_type: string | null;
  is_directory: boolean;
  tags: string[] | null;
  category: string | null;
  description: string | null;
  is_favorite: boolean;
  preview_kind: string | null;
  preview_status: string;
  ocr_status: string;
  encrypted: boolean;
  deleted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface FileView {
  id: string;
  projectId: string;
  ownerId: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string | null;
  storageProvider: string | null;
  mimeType: string | null;
  isDirectory: boolean;
  tags: string[];
  category: string | null;
  description: string | null;
  isFavorite: boolean;
  previewKind: string | null;
  previewStatus: string;
  ocrStatus: string;
  encrypted: boolean;
  deletedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function toFile(row: FileRow): FileView {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerId: row.owner_id,
    path: row.path,
    sizeBytes: Number(row.size_bytes ?? 0),
    sha256: row.sha256,
    storageKey: row.storage_key ?? null,
    storageProvider: row.storage_provider ?? null,
    mimeType: row.mime_type ?? null,
    isDirectory: row.is_directory,
    tags: row.tags ?? [],
    category: row.category ?? null,
    description: row.description ?? null,
    isFavorite: row.is_favorite,
    previewKind: row.preview_kind ?? null,
    previewStatus: row.preview_status,
    ocrStatus: row.ocr_status,
    encrypted: row.encrypted,
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface VersionRow {
  id: string;
  file_id: string;
  version: number;
  content_sha256: string;
  size_bytes: number;
  storage_key: string | null;
  change_reason: string | null;
  created_by: string | null;
  parent_version: number | null;
  rollback_reference: string | null;
  created_at: Date | string;
}

export interface VersionView {
  id: string;
  fileId: string;
  version: number;
  contentSha256: string;
  sizeBytes: number;
  storageKey: string | null;
  changeReason: string | null;
  createdBy: string | null;
  parentVersion: number | null;
  rollbackReference: string | null;
  createdAt: Date | string;
}

// ---------------------------------------------------------------- access control

/**
 * Owner, project member or explicit file permission grant. The owner of the
 * project is a member of their own project — the owner check covers it.
 */
async function assertFileAccess(q: Q, userId: string, file: FileRow): Promise<void> {
  if (file.owner_id === userId) return;
  const memberRes = await q.query<{ role: string }>(
    'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
    [file.project_id, userId],
  );
  if (memberRes.rows[0]) return;
  const grantRes = await q.query<{ ok: number }>(
    'SELECT 1 AS ok FROM file_permissions WHERE file_id = $1 AND grantee_user_id = $2',
    [file.id, userId],
  );
  if (grantRes.rows[0]) return;
  throw AppError.forbidden('file_access_denied', 'You do not have access to this file');
}

async function getFileRow(q: Q, userId: string, projectId: string, fileId: string): Promise<FileRow> {
  const res = await q.query<FileRow>(
    'SELECT * FROM files WHERE id = $1 AND project_id = $2',
    [fileId, projectId],
  );
  const row = res.rows[0] ?? null;
  if (!row) throw AppError.notFound('File');
  await assertFileAccess(q, userId, row);
  return row;
}

// ---------------------------------------------------------------- activity

async function recordFileActivity(
  fileId: string,
  projectId: string,
  actorUserId: string,
  action: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await withTenant(actorUserId, (q) => q.query(
      `INSERT INTO file_activity (id, file_id, project_id, actor_user_id, action, detail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())`,
      [newId('fac'), fileId, projectId, actorUserId, action, detail ? JSON.stringify(detail) : null],
    ));
  } catch {
    /* activity history must never break the operation */
  }
}

// ---------------------------------------------------------------- upload

export interface UploadOptions {
  tags?: string[];
  category?: string;
  description?: string;
}

export async function uploadFile(
  userId: string,
  projectId: string,
  rawPath: string,
  buffer: Buffer,
  mimeType?: string,
  options?: UploadOptions,
): Promise<FileView> {
  const path = normalizePath(rawPath);
  if (!path) throw AppError.badRequest('path_invalid', 'Path is invalid (empty or traversal)');
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw AppError.badRequest('path_invalid', 'Path contains control characters');
  }
  if (isProtectedName(path)) {
    throw AppError.badRequest('protected_path', 'This path is protected (credentials/keys are never uploaded)');
  }
  const mime = inferMime(path, mimeType);
  if (isBlockedExtension(path) || isBlockedMime(mime)) {
    throw AppError.badRequest('blocked_type', 'This file type is blocked by the upload policy');
  }
  const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024;
  if (buffer.length > maxBytes) {
    throw AppError.badRequest('file_too_large', `File exceeds the ${env.MAX_UPLOAD_MB} MB upload limit`);
  }

  // Tenant gate: the caller must own the project or belong to it (member /
  // team). Without this, any authenticated user could plant files into a
  // victim's project namespace (the overwrite path is already protected by
  // assertFileAccess; only the new-file path was missing the check).
  await getProject(userId, projectId);

  const tags = cleanTags(options?.tags);
  const category = options?.category?.trim() || null;
  const description = options?.description?.trim() || null;
  const sha = sha256Hex(buffer);
  const preview = previewFor(mime, path);
  const encrypt = storageEncryptionEnabled();
  const stored = encrypt ? encryptBuffer(buffer) : buffer;

  const existing = await withTenant(userId, async (q) => {
    const res = await q.query<{ id: string }>(
      'SELECT id FROM files WHERE project_id = $1 AND path = $2 FOR UPDATE',
      [projectId, path],
    );
    return res.rows[0]?.id ?? null;
  });

  if (!existing) {
    const fileId = newId(PREFIX.FILE);
    const storageKey = `${FILE_STORAGE_PREFIX}/projects/${projectId}/${fileId}`;
    await storage.put(storageKey, stored, mime);
    await withTenant(userId, async (q) => {
      await q.query(
        `INSERT INTO files
           (id, project_id, owner_id, path, size_bytes, sha256, storage_key, storage_provider,
            mime_type, tags, category, description, preview_kind, preview_status, ocr_status,
            encrypted, is_favorite)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          fileId, projectId, userId, path, buffer.length, sha, storageKey, storage.kind,
          mime, tags, category, description, preview.kind, preview.status, OcrStatus.UNAVAILABLE,
          encrypt, false,
        ],
      );
      await q.query(
        `INSERT INTO file_versions
           (id, file_id, version, content_sha256, size_bytes, storage_key, change_reason,
            created_by, parent_version, rollback_reference)
         VALUES ($1,$2,1,$3,$4,$5,'upload',$6,0,NULL)`,
        [newId('ver'), fileId, sha, buffer.length, storageKey, userId],
      );
    });
    await incrementUsage(userId, 'storage_bytes_used', buffer.length);
    await recordAudit({
      action: AuditAction.FILE_UPLOADED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'file',
      resourceId: fileId,
      detail: { path, sizeBytes: buffer.length },
    });
    await recordFileActivity(fileId, projectId, userId, 'file.uploaded', { path, sizeBytes: buffer.length });
    const row = await withTenant(userId, async (q) => {
      const res = await q.query<FileRow>('SELECT * FROM files WHERE id = $1', [fileId]);
      return res.rows[0] ?? null;
    });
    return toFile(row ?? ({ id: fileId, project_id: projectId, owner_id: userId, path } as FileRow));
  }

  // ------------------------------------------------------------ overwrite → new version
  const fileId = existing;
  const { file, oldSize, parentVersion } = await withTenant(userId, async (q) => {
    const file = await getFileRow(q, userId, projectId, fileId);
    const oldRes = await q.query<{ size_bytes: number; encrypted: boolean }>(
      'SELECT size_bytes, encrypted FROM files WHERE id = $1',
      [fileId],
    );
    const oldSize = Number(oldRes.rows[0]?.size_bytes ?? 0);
    const maxV = await q.query<{ v: number }>(
      'SELECT COALESCE(MAX(version),0) AS v FROM file_versions WHERE file_id = $1 FOR UPDATE',
      [fileId],
    );
    const parentVersion = Number(maxV.rows[0]?.v ?? 0);
    return { file, oldSize, parentVersion };
  });
  const nextVersion = parentVersion + 1;

  const storageKey = file.storage_key ?? `${FILE_STORAGE_PREFIX}/projects/${projectId}/${fileId}`;
  if (file.storage_key) {
    const previous = await storage.get(file.storage_key);
    const versionKey = `${storageKey}/versions/${parentVersion}`;
    await storage.put(versionKey, previous, file.mime_type ?? undefined);
    await withTenant(userId, async (q) => {
      await q.query(
        `INSERT INTO file_versions
           (id, file_id, version, content_sha256, size_bytes, storage_key, change_reason,
            created_by, parent_version, rollback_reference)
         VALUES ($1,$2,$3,$4,$5,$6,'upload',$7,$8,$9)`,
        [newId('ver'), fileId, nextVersion, file.sha256, oldSize, versionKey, userId, parentVersion, null],
      );
    });
  } else {
    await withTenant(userId, async (q) => {
      await q.query(
        `INSERT INTO file_versions
           (id, file_id, version, content_sha256, size_bytes, storage_key, change_reason,
            created_by, parent_version, rollback_reference)
         VALUES ($1,$2,$3,$4,$5,$6,'upload',$7,$8,$9)`,
        [newId('ver'), fileId, nextVersion, file.sha256, oldSize, storageKey, userId, parentVersion, null],
      );
    });
  }

  await storage.put(storageKey, stored, mime);
  await withTenant(userId, async (q) => {
    await q.query(
      `UPDATE files SET sha256 = $2, size_bytes = $3, storage_key = $4, mime_type = $5,
         preview_kind = $6, preview_status = $7, ocr_status = $8, encrypted = $9
       WHERE id = $1`,
      [fileId, sha, buffer.length, storageKey, mime, preview.kind, preview.status, OcrStatus.UNAVAILABLE, encrypt],
    );
  });
  const delta = buffer.length - oldSize;
  if (delta !== 0) await incrementUsage(userId, 'storage_bytes_used', delta);
  await recordAudit({
    action: AuditAction.FILE_UPLOADED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'file',
    resourceId: fileId,
    detail: { path, version: nextVersion, sizeBytes: buffer.length },
  });
  await recordFileActivity(fileId, projectId, userId, 'file.uploaded', { path, version: nextVersion });

  const row = await withTenant(userId, async (q) => {
    const res = await q.query<FileRow>('SELECT * FROM files WHERE id = $1', [fileId]);
    return res.rows[0] ?? null;
  });
  return toFile(row ?? file);
}

// ---------------------------------------------------------------- generated images (IMAGE_GENERATION)

/**
 * Persist a generated image (server-side) as a files-gateway row + storage
 * blob + file_reference. The base64 payload never travels to a client; only
 * the file id + mime are returned. Ownership/tenant scoping reuses the files
 * table exactly like uploads (owner + project), so existing RLS/tenant rules
 * apply unchanged.
 */
export async function persistGeneratedImage(
  userId: string,
  projectId: string,
  opts: { dataB64: string; mimeType: string; messageId?: string; prompt?: string },
): Promise<{ fileId: string; mimeType: string }> {
  const buffer = Buffer.from(opts.dataB64, 'base64');
  if (buffer.length === 0) throw AppError.badRequest('image_empty', 'Generated image payload was empty');
  const mime = opts.mimeType.startsWith('image/') ? opts.mimeType : 'image/png';
  const ext = MIME_BY_EXT[mime] === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  const path = `.codeconclave/generated/${newId('img')}.${ext}`;
  const fileId = newId(PREFIX.FILE);
  const sha = sha256Hex(buffer);
  const encrypt = storageEncryptionEnabled();
  const stored = encrypt ? encryptBuffer(buffer) : buffer;
  const storageKey = `${FILE_STORAGE_PREFIX}/projects/${projectId}/${fileId}`;
  await storage.put(storageKey, stored, mime);
  await withTenant(userId, async (q) => {
    await q.query(
      `INSERT INTO files
         (id, project_id, owner_id, path, size_bytes, sha256, storage_key, storage_provider,
          mime_type, category, description, preview_kind, preview_status, ocr_status,
          encrypted, is_favorite)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'image','AI-generated image',NULL,$10,$11,$12,false)`,
      [
        fileId, projectId, userId, path, buffer.length, sha, storageKey, storage.kind,
        mime, PreviewKind.IMAGE, PreviewStatus.UNAVAILABLE, encrypt,
      ],
    );
    await q.query(
      `INSERT INTO file_versions
         (id, file_id, version, content_sha256, size_bytes, storage_key, change_reason,
          created_by, parent_version)
       VALUES ($1,$2,1,$3,$4,$5,'generated',$6,0)`,
      [newId('ver'), fileId, sha, buffer.length, storageKey, userId],
    );
    await incrementUsage(userId, 'storage_bytes_used', buffer.length);
    if (opts.messageId) {
      await q.query(
        `INSERT INTO file_references (id, file_id, project_id, ref_type, ref_id)
         VALUES ($1,$2,$3,'message',$4)`,
        [newId('fref'), fileId, projectId, opts.messageId],
      );
    }
  });
  await recordAudit({
    action: 'ai.image_generated',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'file',
    resourceId: fileId,
    detail: { mime, mimeTypeUnsafe: false, generated: true, messageId: opts.messageId ?? null },
  });
  return { fileId, mimeType: mime };
}

// ---------------------------------------------------------------- read / preview

export async function getFile(userId: string, projectId: string, fileId: string): Promise<FileView> {
  return toFile(await withTenant(userId, async (q) => getFileRow(q, userId, projectId, fileId)));
}

export async function getFileContent(
  userId: string,
  projectId: string,
  fileId: string,
): Promise<{ buffer: Buffer; mimeType: string | null; name: string }> {
  const file = await withTenant(userId, async (q) => getFileRow(q, userId, projectId, fileId));
  if (!file.storage_key) throw AppError.conflict('content_missing', 'This file has no stored content');
  let raw = await storage.get(file.storage_key);
  if (file.encrypted) {
    try {
      raw = decryptBuffer(raw);
    } catch {
      throw AppError.conflict('decrypt_failed', 'Stored content could not be decrypted');
    }
  }
  if (sha256Hex(raw) !== file.sha256) {
    throw AppError.conflict('hash_mismatch', 'Stored content hash does not match the record');
  }
  await recordAudit({
    action: AuditAction.FILE_READ,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'file',
    resourceId: file.id,
  });
  await recordFileActivity(file.id, file.project_id, userId, 'file.read');
  return { buffer: raw, mimeType: file.mime_type, name: file.path };
}

export async function listFiles(userId: string, projectId: string): Promise<FileView[]> {
  await getProject(userId, projectId);
  const rows = await withTenant(userId, async (q) =>
    (
      await q.query<FileRow>(
        'SELECT * FROM files WHERE project_id = $1 AND deleted_at IS NULL ORDER BY path',
        [projectId],
      )
    ).rows,
  );
  return rows.map(toFile);
}

// ---------------------------------------------------------------- folder tree

export interface TreeEntry {
  name: string;
  type: 'folder' | 'file';
  path?: string;
  file?: FileView;
  children?: TreeEntry[];
}

export async function fileTree(userId: string, projectId: string): Promise<TreeEntry[]> {
  await getProject(userId, projectId);
  const rows = await withTenant(userId, async (q) =>
    (
      await q.query<FileRow>(
        'SELECT * FROM files WHERE project_id = $1 AND deleted_at IS NULL ORDER BY path',
        [projectId],
      )
    ).rows,
  );
  const root: TreeEntry[] = [];
  const folders = new Map<string, TreeEntry>();

  const ensureFolder = (segments: string[]): TreeEntry => {
    const key = segments.join('/');
    let node = folders.get(key);
    if (node) return node;
    node = { name: segments[segments.length - 1]!, type: 'folder', children: [] };
    folders.set(key, node);
    if (segments.length === 1) {
      root.push(node);
    } else {
      const parent = ensureFolder(segments.slice(0, -1));
      parent.children!.push(node);
    }
    return node;
  };

  for (const row of rows) {
    const segments = row.path.split('/');
    if (segments.length === 1) {
      root.push({ name: row.path, type: 'file', path: row.path, file: toFile(row) });
    } else {
      const parent = ensureFolder(segments.slice(0, -1));
      parent.children!.push({ name: segments[segments.length - 1]!, type: 'file', path: row.path, file: toFile(row) });
    }
  }
  return root;
}

// ---------------------------------------------------------------- favorites / recent / trash list

const TENANT_CLAUSE = '(f.owner_id = $1 OR f.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1))';

export async function favoriteFiles(userId: string): Promise<FileView[]> {
  const rows = await withTenant(userId, async (q) =>
    (
      await q.query<FileRow>(
        `SELECT f.* FROM files f WHERE ${TENANT_CLAUSE} AND f.deleted_at IS NULL AND f.is_favorite ORDER BY f.updated_at DESC LIMIT 50`,
        [userId],
      )
    ).rows,
  );
  return rows.map(toFile);
}

export async function recentFiles(userId: string): Promise<FileView[]> {
  const rows = await withTenant(userId, async (q) =>
    (
      await q.query<FileRow>(
        `SELECT f.* FROM files f WHERE ${TENANT_CLAUSE} AND f.deleted_at IS NULL ORDER BY f.updated_at DESC LIMIT 20`,
        [userId],
      )
    ).rows,
  );
  return rows.map(toFile);
}

export async function trashFiles(userId: string): Promise<FileView[]> {
  const rows = await withTenant(userId, async (q) =>
    (
      await q.query<FileRow>(
        `SELECT f.* FROM files f WHERE ${TENANT_CLAUSE} AND f.deleted_at IS NOT NULL
           AND f.deleted_at > now() - interval '30 days'
         ORDER BY f.deleted_at DESC`,
        [userId],
      )
    ).rows,
  );
  return rows.map(toFile);
}

// ---------------------------------------------------------------- versions + rollback

export async function fileVersions(userId: string, projectId: string, fileId: string): Promise<VersionView[]> {
  const rows = await withTenant(userId, async (q) => {
    const file = await getFileRow(q, userId, projectId, fileId);
    return (
      await q.query<VersionRow>(
        `SELECT id, file_id, version, content_sha256, size_bytes, storage_key, change_reason,
                created_by, parent_version, rollback_reference, created_at
         FROM file_versions WHERE file_id = $1 ORDER BY version DESC`,
        [file.id],
      )
    ).rows;
  });
  return rows.map((r) => ({
    id: r.id,
    fileId: r.file_id,
    version: Number(r.version),
    contentSha256: r.content_sha256,
    sizeBytes: Number(r.size_bytes),
    storageKey: r.storage_key,
    changeReason: r.change_reason,
    createdBy: r.created_by,
    parentVersion: r.parent_version === null ? null : Number(r.parent_version),
    rollbackReference: r.rollback_reference,
    createdAt: r.created_at,
  }));
}

/**
 * Restore a historical version: verify the CURRENT stored hash against the
 * record, verify the TARGET version hash, write the target bytes to the
 * file's live storage key and record a new version row referencing the
 * rollback. Never restores content whose hash cannot be verified.
 */
export async function restoreFileVersion(
  userId: string,
  projectId: string,
  fileId: string,
  version: number,
): Promise<VersionView> {
  const file = await withTenant(userId, async (q) => getFileRow(q, userId, projectId, fileId));
  if (!file.storage_key) throw AppError.conflict('content_missing', 'This file has no stored content');
  const current = await storage.get(file.storage_key);
  const currentRaw = file.encrypted ? decryptBuffer(current) : current;
  if (sha256Hex(currentRaw) !== file.sha256) {
    throw AppError.conflict('hash_mismatch', 'Stored content hash does not match the record');
  }

  const { target, parentVersion } = await withTenant(userId, async (q) => {
    const targetRes = await q.query<VersionRow>(
      'SELECT * FROM file_versions WHERE file_id = $1 AND version = $2',
      [file.id, version],
    );
    const target = targetRes.rows[0] ?? null;
    if (!target) throw AppError.notFound('File version');
    if (!target.storage_key) throw AppError.conflict('content_missing', 'Version has no stored content');
    const maxV = await q.query<{ v: number }>(
      'SELECT COALESCE(MAX(version),0) AS v FROM file_versions WHERE file_id = $1',
      [file.id],
    );
    const parentVersion = Number(maxV.rows[0]?.v ?? 0);
    return { target, parentVersion };
  });
  const targetRaw = await storage.get(target.storage_key!);
  const targetBytes = file.encrypted ? decryptBuffer(targetRaw) : targetRaw;
  if (sha256Hex(targetBytes) !== target.content_sha256) {
    throw AppError.conflict('hash_mismatch', 'Version content hash does not match the record');
  }
  const nextVersion = parentVersion + 1;

  const restored = file.encrypted ? encryptBuffer(targetBytes) : targetBytes;
  await storage.put(file.storage_key, restored);
  await withTenant(userId, async (q) => {
    await q.query(
      `INSERT INTO file_versions
         (id, file_id, version, content_sha256, size_bytes, storage_key, change_reason,
          created_by, parent_version, rollback_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        newId('ver'), file.id, nextVersion, target.content_sha256, Number(target.size_bytes),
        file.storage_key, 'restore-v1', userId, parentVersion, `version:${version}`,
      ],
    );
    await q.query(
      'UPDATE files SET sha256 = $2, size_bytes = $3, updated_at = now() WHERE id = $1',
      [file.id, target.content_sha256, Number(target.size_bytes)],
    );
  });
  const delta = Number(target.size_bytes) - Number(file.size_bytes ?? 0);
  if (delta !== 0) await incrementUsage(userId, 'storage_bytes_used', delta);
  await recordAudit({
    action: AuditAction.FILE_VERSION_RESTORED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'file',
    resourceId: file.id,
    detail: { version, restoredVersion: nextVersion },
  });
  await recordFileActivity(file.id, file.project_id, userId, 'file.version_restored', { version, restoredVersion: nextVersion });
  return {
    id: newId('ver'),
    fileId: file.id,
    version: nextVersion,
    contentSha256: target.content_sha256,
    sizeBytes: Number(target.size_bytes),
    storageKey: file.storage_key,
    changeReason: 'restore-v1',
    createdBy: userId,
    parentVersion,
    rollbackReference: `version:${version}`,
    createdAt: new Date(),
  };
}

// ---------------------------------------------------------------- metadata

export async function setFileTags(userId: string, projectId: string, fileId: string, tags: string[]): Promise<FileView> {
  const file = await withTenant(userId, async (q) => {
    const f = await getFileRow(q, userId, projectId, fileId);
    const cleaned = cleanTags(tags);
    await q.query('UPDATE files SET tags = $2, updated_at = now() WHERE id = $1', [f.id, cleaned]);
    return { ...f, tags: cleaned };
  });
  await recordAudit({
    action: AuditAction.FILE_TAGS_UPDATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'file',
    resourceId: file.id,
    detail: { tags: file.tags },
  });
  return toFile(file);
}

export async function setFileCategory(userId: string, projectId: string, fileId: string, category: string): Promise<FileView> {
  const file = await withTenant(userId, async (q) => {
    const f = await getFileRow(q, userId, projectId, fileId);
    const cleaned = category.trim() || null;
    await q.query('UPDATE files SET category = $2, updated_at = now() WHERE id = $1', [f.id, cleaned]);
    return { ...f, category: cleaned };
  });
  await recordAudit({
    action: AuditAction.FILE_CATEGORY_UPDATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'file',
    resourceId: file.id,
    detail: { category: file.category },
  });
  return toFile(file);
}

export async function toggleFavorite(userId: string, projectId: string, fileId: string, favorite: boolean): Promise<FileView> {
  const file = await withTenant(userId, async (q) => {
    const f = await getFileRow(q, userId, projectId, fileId);
    await q.query('UPDATE files SET is_favorite = $2, updated_at = now() WHERE id = $1', [f.id, favorite]);
    return { ...f, is_favorite: favorite };
  });
  await recordAudit({
    action: AuditAction.FILE_FAVORITED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'file',
    resourceId: file.id,
    detail: { favorite },
  });
  return toFile(file);
}

// ---------------------------------------------------------------- references

export async function addFileReference(
  userId: string,
  projectId: string,
  fileId: string,
  refType: string,
  refId: string,
): Promise<void> {
  if (!REFERENCE_TYPES.has(refType)) {
    throw AppError.badRequest('invalid_reference_type', `Reference type must be one of: ${[...REFERENCE_TYPES].join(', ')}`);
  }
  const file = await withTenant(userId, async (q) => {
    const f = await getFileRow(q, userId, projectId, fileId);
    await q.query(
      `INSERT INTO file_references (id, file_id, project_id, ref_path, ref_type, ref_id, created_by, created_at)
       VALUES ($1,$2,$3,NULL,$4,$5,$6,now())
       ON CONFLICT (ref_type, ref_id, file_id) DO NOTHING`,
      [newId('ref'), f.id, f.project_id, refType, refId, userId],
    );
    return f;
  });
  await recordAudit({
    action: AuditAction.FILE_REFERENCE_ADDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'file',
    resourceId: file.id,
    detail: { refType, refId },
  });
}

// ---------------------------------------------------------------- permissions

export async function setFilePermission(
  userId: string,
  projectId: string,
  fileId: string,
  permission: string,
  granteeUserId: string,
  granted: boolean,
): Promise<void> {
  if (!PERMISSION_VALUES.has(permission)) {
    throw AppError.badRequest('invalid_permission', 'Permission must be read, write, or delete');
  }
  await withTenant(userId, async (q) => {
    const file = await getFileRow(q, userId, projectId, fileId);
    if (granted) {
      await q.query(
        `INSERT INTO file_permissions (id, file_id, grantee_user_id, permission, granted_by, created_at)
         VALUES ($1,$2,$3,$4,$5,now())`,
        [newId('fpr'), file.id, granteeUserId, permission, userId],
      );
      await recordAudit({
        action: AuditAction.FILE_PERMISSION_GRANTED,
        actorUserId: userId,
        scope: 'USER',
        tenantId: userId,
        resourceType: 'file',
        resourceId: file.id,
        detail: { granteeUserId, permission },
      });
    } else {
      await q.query(
        'DELETE FROM file_permissions WHERE file_id = $1 AND grantee_user_id = $2',
        [file.id, granteeUserId],
      );
      await recordAudit({
        action: AuditAction.FILE_PERMISSION_REVOKED,
        actorUserId: userId,
        scope: 'USER',
        tenantId: userId,
        resourceType: 'file',
        resourceId: file.id,
        detail: { granteeUserId, permission },
      });
    }
  });
}

// ---------------------------------------------------------------- trash lifecycle

export async function softDeleteFile(userId: string, projectId: string, fileId: string): Promise<FileView> {
  const file = await withTenant(userId, async (q) => {
    const f = await getFileRow(q, userId, projectId, fileId);
    if (f.deleted_at) return f;
    await q.query('UPDATE files SET deleted_at = now() WHERE id = $1 AND project_id = $2', [f.id, projectId]);
    return { ...f, deleted_at: new Date() };
  });
  await incrementUsage(userId, 'storage_bytes_used', -Number(file.size_bytes ?? 0));
  await recordAudit({
    action: AuditAction.FILE_TRASHED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'file',
    resourceId: file.id,
  });
  await recordFileActivity(file.id, projectId, userId, 'file.trashed');
  return toFile(file);
}

export async function restoreFile(userId: string, projectId: string, fileId: string): Promise<FileView> {
  const restored = await withTenant(userId, async (q) => {
    const file = await getFileRow(q, userId, projectId, fileId);
    const result = await q.query(
      'UPDATE files SET deleted_at = NULL WHERE id = $1 AND project_id = $2 RETURNING *',
      [file.id, projectId],
    );
    return (result.rows[0] as FileRow | undefined) ?? file;
  });
  if (restored.deleted_at) {
    await incrementUsage(userId, 'storage_bytes_used', Number(restored.size_bytes ?? 0));
  }
  await recordAudit({
    action: AuditAction.FILE_RESTORED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'file',
    resourceId: restored.id,
  });
  await recordFileActivity(restored.id, projectId, userId, 'file.restored');
  return toFile(restored);
}

export async function restoreFilesBulk(userId: string, projectId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  await getProject(userId, projectId);
  const { rows, count } = await withTenant(userId, async (q) => {
    const result = await q.query(
      `UPDATE files SET deleted_at = NULL WHERE id = ANY($1::text[]) AND project_id = $2
         AND deleted_at IS NOT NULL
       RETURNING id, size_bytes`,
      [ids, projectId],
    );
    return { rows: (result.rows ?? []) as { id: string; size_bytes: number }[], count: result.rowCount ?? null };
  });
  for (const row of rows) {
    await incrementUsage(userId, 'storage_bytes_used', Number(row.size_bytes ?? 0));
    await recordAudit({
      action: AuditAction.FILE_RESTORED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'file',
      resourceId: row.id,
    });
  }
  return count ?? rows.length;
}

export async function softDeleteFilesBulk(userId: string, projectId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  await getProject(userId, projectId);
  const { rows, count } = await withTenant(userId, async (q) => {
    const result = await q.query(
      `UPDATE files SET deleted_at = now() WHERE id = ANY($1::text[]) AND project_id = $2
         AND deleted_at IS NULL
       RETURNING id, size_bytes`,
      [ids, projectId],
    );
    return { rows: (result.rows ?? []) as { id: string; size_bytes: number }[], count: result.rowCount ?? null };
  });
  for (const row of rows) {
    await incrementUsage(userId, 'storage_bytes_used', -Number(row.size_bytes ?? 0));
    await recordAudit({
      action: AuditAction.FILE_TRASHED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'file',
      resourceId: row.id,
    });
  }
  return count ?? rows.length;
}

// ---------------------------------------------------------------- permanent delete (trashed-only)

async function purgeFileRow(q: Q, row: FileRow): Promise<void> {
  if (row.storage_key) await storage.delete(row.storage_key);
  await q.query('DELETE FROM file_versions WHERE file_id = $1', [row.id]);
  await q.query('DELETE FROM file_permissions WHERE file_id = $1', [row.id]);
  await q.query('DELETE FROM files WHERE id = $1', [row.id]);
}

export async function permanentDeleteFile(userId: string, projectId: string, fileId: string): Promise<void> {
  const row = await withTenant(userId, async (q) => {
    const res = await q.query<FileRow>(
      'SELECT * FROM files WHERE id = $1 AND project_id = $2 AND deleted_at IS NOT NULL',
      [fileId, projectId],
    );
    const r = res.rows[0] ?? null;
    if (!r) throw AppError.conflict('not_trashed', 'Only trashed files can be permanently deleted');
    await assertFileAccess(q, userId, r);
    return r;
  });
  await storage.delete(row.storage_key!);
  await withTenant(userId, async (q) => purgeFileRow(q, row));
  await recordAudit({
    action: AuditAction.FILE_DELETED_PERMANENT,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'file',
    resourceId: fileId,
  });
}

export async function purgeFilesBulk(userId: string, projectId: string, ids: string[]): Promise<number> {
  let purged = 0;
  for (const id of ids) {
    const row = await withTenant(userId, async (q) => {
      const res = await q.query<FileRow>(
        'SELECT * FROM files WHERE id = $1 AND project_id = $2 AND deleted_at IS NOT NULL',
        [id, projectId],
      );
      const r = res.rows[0] ?? null;
      if (!r) return null;
      await assertFileAccess(q, userId, r);
      return r;
    });
    if (!row) continue;
    await storage.delete(row.storage_key!);
    await withTenant(userId, async (q) => purgeFileRow(q, row));
    purged += 1;
  }
  if (purged > 0) {
    await recordAudit({
      action: AuditAction.TRASH_PURGED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'trash',
      detail: { purged },
    });
  }
  return purged;
}

/**
 * Expiry sweep: permanently delete files past the 30-day retention window.
 * Tenant-scoped when a user id is given, system-wide otherwise. File
 * references are never deleted — historical references survive purges.
 */
export async function purgeExpiredTrash(userId?: string): Promise<number> {
  const retention = `${FileRetention.TRASH_RETENTION_DAYS} days`;
  let rows: FileRow[];
  if (userId) {
    rows = await withTenant(userId, async (q) =>
      (
        await q.query<FileRow>(
          `SELECT f.* FROM files f WHERE f.deleted_at IS NOT NULL AND f.deleted_at < now() - $2::interval
             AND (f.owner_id = $1 OR f.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1))`,
          [userId, retention],
        )
      ).rows,
    );
  } else {
    rows = await withSystem(async (q) =>
      (
        await q.query<FileRow>(
          'SELECT f.* FROM files f WHERE f.deleted_at IS NOT NULL AND f.deleted_at < now() - $1::interval',
          [retention],
        )
      ).rows,
    );
  }
  let purged = 0;
  for (const row of rows) {
    if (row.storage_key) await storage.delete(row.storage_key);
    if (userId) {
      await withTenant(userId, async (q) => purgeFileRow(q, row));
    } else {
      await withSystem(async (q) => purgeFileRow(q, row));
    }
    purged += 1;
  }
  if (purged > 0) {
    await recordAudit({
      action: AuditAction.TRASH_PURGED,
      actorUserId: userId ?? null,
      scope: 'SYSTEM',
      tenantId: userId ?? null,
      resourceType: 'trash',
      detail: { purged },
    });
  }
  return purged;
}

// ---------------------------------------------------------------- search, references, activity (read views)

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Project-scoped file search (path ILIKE). Requires owner or membership
 * access to the project.
 */
export async function searchProjectFiles(userId: string, projectId: string, q: string): Promise<FileView[]> {
  const project = await getProject(userId, projectId);
  if (!project) throw AppError.notFound('Project');
  const rows = await withTenant(userId, async (qc) =>
    (
      await qc.query<FileRow>(
        `SELECT * FROM files
         WHERE project_id = $1 AND deleted_at IS NULL AND path ILIKE $2
         ORDER BY path LIMIT 100`,
        [projectId, `%${escapeLike(q.trim())}%`],
      )
    ).rows,
  );
  return rows.map(toFile);
}

export interface FileReferenceRow {
  id: string;
  file_id: string;
  ref_path: string | null;
  ref_type: string;
  ref_id: string | null;
  created_by: string | null;
  created_at: Date | string;
}

/** List the references pointing at a file (reference rows survive purges). */
export async function listFileReferences(
  userId: string,
  projectId: string,
  fileId: string,
): Promise<FileReferenceRow[]> {
  return withTenant(userId, async (q) => {
    const file = await getFileRow(q, userId, projectId, fileId);
    return (
      await q.query<FileReferenceRow>(
        `SELECT fr.id, fr.file_id, fr.ref_path, fr.ref_type, fr.ref_id, fr.created_by, fr.created_at
         FROM file_references fr
         WHERE fr.file_id = $1
         ORDER BY fr.created_at DESC`,
        [file.id],
      )
    ).rows;
  });
}

export interface FileActivityRow {
  id: string;
  file_id: string;
  actor_user_id: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  created_at: Date | string;
}

/** Recent activity for a file (actions recorded by recordFileActivity). */
export async function listFileActivity(
  userId: string,
  projectId: string,
  fileId: string,
): Promise<FileActivityRow[]> {
  return withTenant(userId, async (q) => {
    const file = await getFileRow(q, userId, projectId, fileId);
    return (
      await q.query<FileActivityRow>(
        `SELECT id, file_id, actor_user_id, action, detail, created_at
         FROM file_activity
         WHERE file_id = $1
         ORDER BY created_at DESC LIMIT 50`,
        [file.id],
      )
    ).rows;
  });
}