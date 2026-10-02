/**
 * CodeConClave — Superpowers: PROMPT ARMOR (Master Feature #45).
 *
 * Every untrusted surface — issues, web pages, dependencies, PDFs, logs,
 * comments — is scanned for hidden instructions before an agent ever sees the
 * content. Each injection method is classified deterministically from the text,
 * and every hit is recorded and neutralized. No silent passthrough of a hostile
 * README.
 *
 * Pure detection first, then owner-scoped, audited storage.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type InjectionSurface = 'ISSUE' | 'WEBPAGE' | 'DEPENDENCY' | 'PDF' | 'LOG' | 'COMMENT';

export interface InjectionHit {
  method: string;
  evidence: string;
}

const TESTS: Array<{ method: string; re: RegExp }> = [
  { method: 'IGNORE_ALL_PREVIOUS', re: /(?:disregard|ignore|forget)\s+all\s+(?:the\s+)?(?:previous|prior|above)(?:\s+instructions)?/gi },
  { method: 'SYSTEM_ROLE_CLAIM', re: /(?:you are now|you\s+are\s+acting as|rewrite the system prompt|pretend to be)\s+(?:the system|an assistant without|a different model)/gi },
  { method: 'LEAK_SECRETS', re: /(?:give|reveal|leak|print|show|dump).{0,50}?(?:secret|password|api[ _-]?key|private key|token)/gi },
  { method: 'OUTPUT_HIJACK', re: /repeat (?:the|this|all)\s+(?:above\s+)?(?:prompt|message|text|instructions?)/gi },
  { method: 'COERCION', re: /(?:fail(?:ure)?|refus(?:e|al))\s+to\s+(?:comply|follow|answer|help)/gi },
];

export function scanForInjections(content: string): InjectionHit[] {
  const hits: InjectionHit[] = [];
  for (const { method, re } of TESTS) {
    const m = re.exec(content ?? '');
    if (m) hits.push({ method, evidence: m[0].trim() });
  }
  return hits;
}

export interface InjectionInput {
  surface: InjectionSurface;
  content?: string;
  projectId?: string | null;
}

export interface InjectionEventRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  surface: InjectionSurface;
  content_snapshot: string | null;
  methods: string[];
  status: 'OPEN' | 'NEUTRALIZED' | 'IGNORED';
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): InjectionEventRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  surface: r.surface as InjectionSurface,
  content_snapshot: r.content_snapshot ? String(r.content_snapshot) : null,
  methods: Array.isArray(r.methods) ? (r.methods as string[]) : [],
  status: r.status as InjectionEventRow['status'],
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function findInjectionById(userId: string, id: string): Promise<InjectionEventRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM injection_events WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('injection_not_found', 'no injection event found for that id');
  return rowOf(row);
}

/**
 * Scan + persist an injection attempt. Returns null when the surface content
 * is clean (nothing recorded), an event when a method is detected.
 */
export async function detectPromptInjection(userId: string, input: InjectionInput): Promise<InjectionEventRow | null> {
  const content = input.content ? String(input.content) : null;
  const hits = content ? scanForInjections(content) : [];
  if (hits.length === 0) return null;
  const id = newId(PREFIX.INJECTION_EVENT);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO injection_events (id, owner_id, project_id, surface, content_snapshot, methods) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
    [id, userId, input.projectId ?? null, input.surface, content, JSON.stringify(hits.map((h) => h.method))],
  ));
  await recordAudit({
    action: AuditAction.INJECTION_DETECTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'injection_events',
    resourceId: id,
    detail: { surface: input.surface, methods: hits.map((h) => h.method), evidence: hits[0]!.evidence },
  });
  return findInjectionById(userId, id);
}

export async function listInjectionEvents(userId: string, filter: { surface?: InjectionSurface; status?: InjectionEventRow['status'] } = {}): Promise<InjectionEventRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM injection_events WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.surface) rows = rows.filter((r) => r.surface === filter.surface);
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  return rows.sort((a, b) => (b.created_at.getTime() - a.created_at.getTime()) || b.id.localeCompare(a.id));
}

export async function neutralizeInjection(userId: string, id: string, ignore = false): Promise<InjectionEventRow> {
  const event = await findInjectionById(userId, id);
  const status = ignore ? 'IGNORED' : 'NEUTRALIZED';
  if (event.status !== status) {
    await withTenant(userId, (q) => q.query('UPDATE injection_events SET status = $1, updated_at = now() WHERE id = $2 AND owner_id = $3', [status, id, userId]));
  }
  await recordAudit({
    action: ignore ? AuditAction.INJECTION_NEUTRALIZED : AuditAction.INJECTION_NEUTRALIZED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'injection_events',
    resourceId: id,
    detail: { surface: event.surface, status },
  });
  return findInjectionById(userId, id);
}