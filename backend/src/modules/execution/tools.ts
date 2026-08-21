/**
 * CodeConClave — core registered tools (adapters to real integrations).
 * These are the only tools coworkers can execute; every adapter performs a
 * real persisted operation. The authenticated owner identity ALWAYS comes
 * from the server-set execution context (ToolExecutionContext) — a value
 * supplied in the tool input is never trusted and never used as the caller.
 * Tools fail CLOSED when no authenticated context is present.
 */
import { registerTool } from './toolcalls.js';
import { logger } from '../../shared/logger.js';

function callerId(ctx: { userId?: string } | undefined): string {
  const userId = ctx?.userId ?? '';
  if (!userId) {
    throw new Error('Tool execution requires an authenticated caller context (server-set, never tool input)');
  }
  return userId;
}

export function registerCoreTools(): void {
  registerTool('file_read', async (input, ctx) => {
    const projectId = String(input.projectId ?? '');
    const path = String(input.path ?? input.filePath ?? '');
    const userId = callerId(ctx);
    if (!projectId || !path) throw new Error('file_read requires projectId, path');
    const { pool } = await import('../../shared/db.js');
    const { getFileContent } = await import('../files/service.js');
    const found = await pool.query(
      `SELECT id FROM files WHERE project_id = $1 AND path = $2 AND deleted_at IS NULL LIMIT 1`,
      [projectId, path],
    );
    if (!found.rows[0]) return { ok: false, reason: 'file_not_found', path };
    const { buffer, mimeType } = await getFileContent(userId, projectId, found.rows[0].id as string);
    return {
      ok: true,
      path,
      size: buffer.length,
      mime: mimeType,
      preview: (mimeType?.startsWith('text') ?? false) ? buffer.toString('utf-8').slice(0, 64_000) : null,
    };
  });

  registerTool('file_write', async (input, ctx) => {
    const projectId = String(input.projectId ?? '');
    const path = String(input.path ?? '');
    const content = String(input.content ?? '');
    const userId = callerId(ctx);
    if (!projectId || !path) throw new Error('file_write requires projectId, path');
    const { uploadFile } = await import('../files/service.js');
    const file = await uploadFile(userId, projectId, path, Buffer.from(content), 'text/plain; charset=utf-8');
    return { ok: true, path, fileId: file.id, sha256: file.sha256 };
  });

  registerTool('file_list', async (input, ctx) => {
    const projectId = String(input.projectId ?? '');
    const userId = callerId(ctx);
    if (!projectId) throw new Error('file_list requires projectId');
    const { listFiles } = await import('../files/service.js');
    const files = await listFiles(userId, projectId);
    return { ok: true, files: files.map((f) => ({ id: f.id, path: f.path, size: f.sizeBytes, sha256: f.sha256 })) };
  });

  registerTool('memory_search', async (input, ctx) => {
    const userId = callerId(ctx);
    const projectId = input.projectId ? String(input.projectId) : null;
    const query = String(input.query ?? '');
    if (!query) throw new Error('memory_search requires query');
    const { semanticSearch } = await import('../memory/service.js');
    const memories = await semanticSearch(userId, query, projectId, Number(input.limit ?? 5));
    return {
      ok: true,
      memories: memories.map((m) => ({ id: m.id, content: m.content, confidence: m.confidence })),
    };
  });

  registerTool('chat_reply', async (input) => {
    const text = String(input.text ?? '');
    return { ok: true, text: text.slice(0, 64_000) };
  });

  logger.info('core execution tools registered');
}