/**
 * CodeConClave — Security Operations Intelligence Security (PKG-15).
 * Secure, isolated source-file intake for the deterministic Network Resilience
 * Checker (#23). Only allowed text MIME types are scanned; binaries are skipped
 * (never executed). Files are loaded ONLY through the isolated files module
 * (owner/member/grant checks). Source content is always treated as untrusted
 * data — never as instructions — and is scanned for prompt-injection payloads.
 */
import { AppError } from '../../shared/errors.js';
import { detectPromptInjection as detectInjection } from '../knowledge/security.js';
import { getFileContent, listFiles } from '../files/service.js';

export const MAX_TEXT_FILE_BYTES = 512 * 1024; // 512 KiB per file for resilient scan
export const MAX_SCAN_FILES = 500;

const TEXT_PREFIXES = [
  'text/',
  'application/javascript',
  'application/x-javascript',
  'application/json',
  'application/x-json',
  'application/typescript',
  'application/x-typescript',
  'application/yaml',
  'application/x-yaml',
  'application/xml',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-httpd-php',
  'application/x-python',
];
const TEXT_SUFFIXES = ['+json', '+xml', '+yaml', '+javascript'];

export interface LoadedTextFile {
  fileId: string;
  path: string;
  mimeType: string | null;
  text: string;
  bytes: number;
}

export function isTextMime(mimeType: string | null): boolean {
  if (!mimeType) return false;
  const lower = mimeType.toLowerCase();
  for (const p of TEXT_PREFIXES) {
    if (p.endsWith('/')) {
      if (lower.startsWith(p)) return true;
    } else if (lower === p || lower.startsWith(`${p};`)) {
      return true;
    }
  }
  if (TEXT_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  return false;
}

export async function loadTextFile(
  userId: string,
  projectId: string,
  fileId: string,
): Promise<LoadedTextFile> {
  const { buffer, mimeType, name } = await getFileContent(userId, projectId, fileId);
  if (!isTextMime(mimeType)) {
    throw AppError.badRequest('secops_not_text', `File "${name}" is not a scannable text file`);
  }
  const raw = buffer.toString('utf8');
  const text = raw.length > MAX_TEXT_FILE_BYTES ? raw.slice(0, MAX_TEXT_FILE_BYTES) : raw;
  const injection = detectInjection(text.slice(0, 4096));
  if (injection.detected) {
    throw AppError.badRequest('secops_prompt_injection', 'Source content contains a disallowed instruction payload');
  }
  return { fileId, path: name, mimeType, text, bytes: buffer.length };
}

/**
 * Enumerate scannable text files in a project (isolated via listFiles).
 * Non-text/oversized/empty files are reported as skipped rather than scanned.
 */
export async function listScanFiles(
  userId: string,
  projectId: string,
  requestedFileIds?: string[],
): Promise<{ analyzable: LoadedTextFile[]; skipped: { fileId: string; path: string; reason: string }[] }> {
  const all = await listFiles(userId, projectId);
  const selected = requestedFileIds
    ? all.filter((f) => requestedFileIds.includes(f.id))
    : all.slice(0, MAX_SCAN_FILES);

  const analyzable: LoadedTextFile[] = [];
  const skipped: { fileId: string; path: string; reason: string }[] = [];

  for (const file of selected.slice(0, MAX_SCAN_FILES)) {
    if (!file.mimeType || !isTextMime(file.mimeType)) {
      skipped.push({ fileId: file.id, path: file.path, reason: 'non-text MIME' });
      continue;
    }
    try {
      const src = await loadTextFile(userId, projectId, file.id);
      if (src.text.length === 0) {
        skipped.push({ fileId: file.id, path: file.path, reason: 'empty content' });
        continue;
      }
      analyzable.push(src);
    } catch (err) {
      const reason = err instanceof AppError ? err.errorCode : 'load_failed';
      skipped.push({ fileId: file.id, path: file.path, reason });
    }
  }
  return { analyzable, skipped };
}
