/**
 * CodeConClave — PKG-22 Advanced Code Workspace — bounded AI editor context.
 * Assembles a small, token-bounded context payload (active file + nearby lines +
 * related files + a few diagnostics + relevant memory). Never dumps the whole
 * repository; respects maxContextBytes.
 */
import { readFileEntry, readSlice } from './fs.js';
import { fetchDiagnosticsSummary } from './diagnostics.js';
import { retrieveWorkspaceMemory } from './memory.js';
import { detectAffectedFiles } from './related.js';
import { workspaceEnabled, maxContextBytes } from './config.js';
import { AppError } from '../../shared/errors.js';

export interface EditorContext {
  activePath: string | null;
  selection?: { line?: number; col?: number };
  nearby: string[] | null;
  relatedFiles: string[];
  diagnostics: unknown[];
  memory: string[];
  truncated: boolean;
  byteLength: number;
}

export async function buildEditorContext(
  userId: string,
  projectId: string,
  relPath: string,
  cursorLine?: number,
  col?: number,
): Promise<EditorContext | null> {
  if (!workspaceEnabled()) throw AppError.conflict('workspace_disabled', 'Advanced Code Workspace is disabled');

  const file = await readFileEntry(projectId, relPath);
  if (!file || file.binary) return { activePath: relPath, nearby: null, relatedFiles: [], diagnostics: [], memory: [], truncated: false, byteLength: 0 };

  const lines = file.content.split('\n');
  const radix = cursorLine ?? 1;
  const start = Math.max(0, radix - 1 - 15);
  const nearby = lines.slice(start, Math.min(lines.length, radix + 15));
  const nearbyText = nearby.join('\n');

  const [related, diagnostics, memory] = await Promise.all([
    detectAffectedFiles(projectId, relPath),
    fetchDiagnosticsSummary(userId, projectId, relPath),
    retrieveWorkspaceMemory(userId, projectId, relPath),
  ]);

  let payload = nearbyText;
  for (const r of related ?? []) payload += `\n--- related: ${r.path} (${r.relation})`;
  const diagLines = (diagnostics?.slice(0, 5) ?? []).map((d) => JSON.stringify(d)).join(' | ');
  payload += `\n--- diagnostics ${diagLines}`;
  for (const m of memory) payload += `\n--- memory ${m}`;

  const bytes = Buffer.byteLength(payload, 'utf8');
  let truncated = false;
  if (bytes > maxContextBytes()) {
    payload = payload.slice(0, maxContextBytes());
    truncated = true;
  }

  return {
    activePath: relPath,
    selection: cursorLine ? { line: cursorLine, col: col ?? 0 } : undefined,
    nearby,
    relatedFiles: (related ?? []).map((r) => r.path),
    diagnostics: diagnostics ?? [],
    memory,
    truncated,
    byteLength: bytes,
  };
}

export { readSlice };
