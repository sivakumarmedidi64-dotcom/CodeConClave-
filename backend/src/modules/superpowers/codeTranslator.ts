/**
 * CodeConClave — Superpowers: CODE TRANSLATOR (Master Feature #61).
 *
 * "Explain this C++ file to me as a Python dev". Code explained in the
 * language and paradigm the developer thinks in — it speaks your language,
 * not the code's.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface TranslatedStep {
  line: number;
  text: string;
  explanation: string;
}

export interface CodeTranslationRow {
  id: string;
  owner_id: string;
  source_lang: string;
  target_lang: string;
  source: string;
  summary: string;
  steps: TranslatedStep[];
  notes: string[];
  status: string;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): CodeTranslationRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  source_lang: String(r.source_lang),
  target_lang: String(r.target_lang),
  source: String(r.source),
  summary: String(r.summary),
  steps: (r.steps ?? []) as TranslatedStep[],
  notes: (r.notes ?? []) as string[],
  status: String(r.status),
  created_at: new Date(r.created_at as string),
});

const PARADIGM_NOTES: Record<string, string> = {
  python: 'duck-typed and dynamic — prefer early returns over deep nesting',
  rust: 'ownership-based — replace null with Option and failures with Result',
  javascript: 'async everywhere — no threads, so reveals assignments stay on the event loop',
  typescript: 'structural typing — define the seam with interfaces, not classes',
  go: 'goroutines — treat shared state as an explicit handoff, not a shared object',
  default: 'idioms differ — keep the interface, translate the mechanism',
};

/** Reads a line and names the construct for the target developer. */
export function keywordExplanation(line: string): string {
  if (/\b(if|else|elif|elsif|unless)\b/.test(line)) return 'condition';
  if (/\b(for|while|foreach|do\b)\b/.test(line)) return 'iteration';
  if (/\b(def|function|fn|func|public|private|sub)\b/.test(line)) return 'declaration / entry point';
  if (/\b(try|catch|except|rescue|panic|raise|throw)\b/.test(line)) return 'error handling';
  if (/\b(await|async|defer)\b/.test(line)) return 'async / deferred boundary';
  if (/\b(begin|transaction|commit|rollback)\b/.test(line)) return 'transaction boundary';
  if (/#\s*include|\b(import|use|require|from)\b/.test(line)) return 'dependency declaration';
  return 'plain statement';
}

export async function translateCode(userId: string, input: { source_lang: string; target_lang: string; source: string }): Promise<CodeTranslationRow> {
  if (!input.source_lang || typeof input.source_lang !== 'string') throw AppError.badRequest('invalid_source_lang', 'the source language is required');
  if (!input.target_lang || typeof input.target_lang !== 'string') throw AppError.badRequest('invalid_target_lang', 'a target language is required');
  if (!input.source || typeof input.source !== 'string') throw AppError.badRequest('empty_source', 'there is no code to translate');

  const lines = input.source.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) throw AppError.badRequest('no_code_to_translate', 'there is no code to translate');
  const steps: TranslatedStep[] = lines.slice(0, 6).map((text, i) => ({ line: i + 1, text, explanation: keywordExplanation(text) }));
  const notes = [
    PARADIGM_NOTES[input.target_lang.toLowerCase()] ?? PARADIGM_NOTES.default!,
    `read through ${lines.length} line(s) of ${input.source_lang} for a ${input.target_lang} developer`,
  ];
  const summary = `${input.source_lang} → ${input.target_lang}: ${lines.length} line(s) explained in the way you think`;
  const id = newId(PREFIX.CODE_TRANSLATION);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO code_translations (id, owner_id, source_lang, target_lang, source, summary, steps, notes, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, userId, input.source_lang, input.target_lang, input.source, summary, steps, notes, 'TRANSLATED'],
  ));
  await recordAudit({
    action: AuditAction.CODE_TRANSLATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'code_translations',
    resourceId: id,
    detail: { source_lang: input.source_lang, target_lang: input.target_lang, lines: lines.length },
  });
  return getCodeTranslation(userId, id);
}

export async function getCodeTranslation(userId: string, id: string): Promise<CodeTranslationRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM code_translations WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('code_translation_not_found', 'no code translation found for that id');
  return rowOf(row);
}

export async function listCodeTranslations(userId: string): Promise<CodeTranslationRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM code_translations WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function codeTranslatorReport(userId: string): Promise<{ translations: number; total_lines: number; target_languages: number }> {
  const translations = await listCodeTranslations(userId);
  return {
    translations: translations.length,
    total_lines: translations.reduce((s, t) => s + t.steps.length, 0),
    target_languages: new Set(translations.map((t) => t.target_lang)).size,
  };
}