/**
 * CodeConClave — PKG-22 Advanced Code Workspace — security helpers.
 * Workspace-root confinement (reuses the runtime projectWorkspaceRoot boundary),
 * authenticated project ownership, path-traversal + protected-path rejection,
 * binary/large-file guards. No files outside the project root are ever reachable.
 */
import path from 'node:path';
import { withTenant, queryOne } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { projectWorkspaceRoot, assertProjectAccess } from '../runtime/security.js';
import { env } from '../../config/env.js';
import { looksLikeSecretPath } from '../execution/policy.js';
import { workspaceEnabled, maxFileBytes } from './config.js';

export { assertProjectAccess };

/** Blocked / protected basenames (mirror the files module policy). */
const PROTECTED_BASENAMES = new Set([
  '.env', '.netrc', '.htpasswd', '.pgpass', '.npmrc', '.pypirc',
  'secrets.json', 'credentials.json', 'id_rsa', 'id_dsa', 'id_ecdsa',
  'id_ed25519', 'id_ed448', '.gitconfig', '.ssh',
]);

const PROTECTED_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx', 'ppk', 'p8']);

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'pdf', 'zip',
  'gz', 'tar', 'docx', 'xlsx', 'pptx', 'exe', 'dll', 'so', 'dylib', 'bin',
  'woff', 'woff2', 'ttf', 'otf', 'class', 'jar', 'lock', 'sqlite', 'db',
]);

/** Normalize a relative workspace path: forward slashes, no leading slash, no traversal. */
export function normalizeRelPath(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  if (raw.includes('\u0000') || /[\u0000-\u001f\u007f]/.test(raw)) return '';
  const cleaned = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '').trim();
  const segments = cleaned.split('/').filter((s) => s !== '' && s !== '.');
  // Refuse absolute or traversal paths outright.
  if (segments.some((s) => s === '..')) return '';
  if (path.isAbsolute(cleaned)) return '';
  return segments.join('/');
}

/** The absolute root for a project (null when the deployment has no root). */
export function rootForProject(projectId: string): string | null {
  return projectWorkspaceRoot(projectId);
}

/** Resolve a relative path under a project root, or throw. */
export function resolveUnderRoot(projectId: string, relPath: string): string {
  const rel = normalizeRelPath(relPath);
  if (!rel) throw AppError.badRequest('path_invalid', 'Path is invalid (empty, absolute, or traversal)');
  const root = rootForProject(projectId);
  if (!root) throw AppError.conflict('workspace_unavailable', 'Workspace root is not configured on this deployment');
  const abs = path.resolve(root, rel);
  const relCheck = path.relative(root, abs);
  if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw AppError.forbidden('path_escape', 'Path escapes the project workspace root');
  }
  return abs;
}

/** Is this relative path protected (credentials / secrets / keys)? */
export function isProtectedRelPath(relPath: string): boolean {
  if (looksLikeSecretPath(relPath)) return true;
  const ext = (relPath.split('.').pop() ?? '').toLowerCase();
  if (PROTECTED_EXTENSIONS.has(ext)) return true;
  const base = (relPath.split('/').pop() ?? '').toLowerCase();
  return PROTECTED_BASENAMES.has(base);
}

/** Reject protected paths with a dedicated error. */
export function assertNotProtected(relPath: string): void {
  if (isProtectedRelPath(relPath)) {
    throw AppError.forbidden('protected_path', 'This path is protected (credentials/keys are never opened or edited)');
  }
}

export function isBinaryPath(relPath: string): boolean {
  const ext = (relPath.split('.').pop() ?? '').toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export function isTextLike(buf: Buffer): boolean {
  const sample = buf.subarray(0, 2048);
  // NUL bytes strongly indicate binary.
  if (sample.includes(0)) return false;
  const text = sample.toString('utf8');
  // High ratio of control chars (excluding \n \t \r) indicates binary.
  const ctrl = (text.match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g) ?? []).length;
  return ctrl / Math.max(text.length, 1) < 0.15;
}

export function exceedsMaxFileBytes(bytes: number): boolean {
  return bytes > maxFileBytes();
}

/** True when the workspace is usable (enabled flag + configured root exists). */
export async function workspaceUsable(projectId: string): Promise<boolean> {
  if (!workspaceEnabled()) return false;
  const root = rootForProject(projectId);
  if (!root) return false;
  const { stat } = await import('node:fs/promises');
  try {
    await stat(root);
    return true;
  } catch {
    return false;
  }
}

export function lookupProjectRow(userId: string, projectId: string) {
  return withTenant<{ id: string } | null>(userId, async (q) =>
    (await q.query<{ id: string }>(
      'SELECT id FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL',
      [projectId, userId],
    )).rows[0] ?? null,
  );
}

export { env };
