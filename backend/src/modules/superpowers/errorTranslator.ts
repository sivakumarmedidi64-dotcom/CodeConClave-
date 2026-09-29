/**
 * CodeConClave — Superpowers: ERROR TRANSLATOR (Master Feature #64).
 *
 * Every stack trace, cryptic compiler error, or CI log — rewritten into one
 * sentence plus the exact fix. Junior-dev superpowers on day one.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ErrorTranslationRow {
  id: string;
  owner_id: string;
  kind: string;
  raw: string;
  line: string | null;
  sentence: string;
  fix: string;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): ErrorTranslationRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  kind: String(r.kind),
  raw: String(r.raw),
  line: r.line == null ? null : String(r.line),
  sentence: String(r.sentence),
  fix: String(r.fix),
  created_at: new Date(r.created_at as string),
});

export interface Translation {
  kind: string;
  line: string | null;
  sentence: string;
  fix: string;
}

const FRAME_RE = /([^\s():]+):(\d+):\d+/;
const readLine = (text: string): string | null => {
  const m = FRAME_RE.exec(text);
  return m ? `${m[1]}:${m[2]}` : null;
};

/** Stack trace → one plain-English sentence + "what to do about it". */
export function translateError(text: string): Translation {
  const t = text.toLowerCase();
  if (/cannot read properties of undefined|undefined is not an object/.test(t)) {
    return { kind: 'runtime_undefined', line: readLine(text), sentence: 'you reached for a property on something that was never defined', fix: 'guard the value before use — check it exists, then act' };
  }
  if (/referenceerror|is not defined/.test(t)) {
    return { kind: 'runtime_unbound_name', line: readLine(text), sentence: 'code touched a name that was never declared in scope', fix: 'declare it in scope, or receive it as an argument' };
  }
  if (/typeerror|expected .* to be/.test(t)) {
    return { kind: 'runtime_type_mismatch', line: readLine(text), sentence: 'an operation ran on the wrong kind of value', fix: 'verify the shape of the value at the seam where it enters' };
  }
  if (/syntax error at or near|error: syntax|sqlstate|sql error/.test(t)) {
    return { kind: 'sql_syntax', line: readLine(text), sentence: 'the database rejected the malformed SQL', fix: 'fix the statement around the quoted token' };
  }
  if (/\bpanic:/.test(t)) {
    return { kind: 'panic', line: readLine(text), sentence: 'the program made an assumption it could not keep', fix: 'find the panicking call and satisfy its precondition' };
  }
  if (/enoent|cannot find module|no such file/.test(t)) {
    return { kind: 'missing_resource', line: readLine(text), sentence: 'a file or package the program expected was not there', fix: 'install or point at the right path, or create the expected file' };
  }
  if (/eaddrinuse/.test(t)) {
    return { kind: 'port_conflict', line: readLine(text), sentence: 'the port you wanted is already taken', fix: 'free the port or bind to another one' };
  }
  if (/fetch failed|econnrefused|connect econnreset|net::err/.test(t)) {
    return { kind: 'connection_failed', line: readLine(text), sentence: 'the outgoing request could not reach its target', fix: 'check the URL, the network path, and that the service is up' };
  }
  return { kind: 'opaque_stderr', line: readLine(text), sentence: 'something failed with an unfamiliar message', fix: 'paste the surrounding log lines — context reveals the real cause' };
}

export async function translateErrorText(userId: string, input: { raw: string }): Promise<ErrorTranslationRow> {
  if (!input.raw || typeof input.raw !== 'string') throw AppError.badRequest('empty_error', 'paste the raw stack trace or log line');
  const { kind, line, sentence, fix } = translateError(input.raw);
  const id = newId(PREFIX.ERROR_TRANSLATION);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO error_translations (id, owner_id, kind, raw, line, sentence, fix) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, kind, input.raw, line, sentence, fix],
  ));
  await recordAudit({
    action: AuditAction.ERROR_TRANSLATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'error_translations',
    resourceId: id,
    detail: { kind, line },
  });
  return getErrorTranslation(userId, id);
}

export async function getErrorTranslation(userId: string, id: string): Promise<ErrorTranslationRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM error_translations WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('error_translation_not_found', 'no error translation found for that id');
  return rowOf(row);
}

export async function listErrorTranslations(userId: string): Promise<ErrorTranslationRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM error_translations WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function errorTranslatorReport(userId: string): Promise<{ translations: number; kinds: number; lines_identified: number }> {
  const translations = await listErrorTranslations(userId);
  return {
    translations: translations.length,
    kinds: new Set(translations.map((t) => t.kind)).size,
    lines_identified: translations.filter((t) => t.line != null).length,
  };
}