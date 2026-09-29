/**
 * CodeConClave — Superpowers: PAIR MIRROR (Master Feature #65).
 *
 * An agent that pairs with you in real time, watches your edits, gently
 * suggests the pattern your team prefers — before you finish the line.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface PairHintRow {
  id: string;
  owner_id: string;
  edit: string;
  pattern: string;
  suggestion: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): PairHintRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  edit: String(r.edit),
  pattern: String(r.pattern),
  suggestion: String(r.suggestion),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export interface DnaPattern {
  name: string;
  triggers: RegExp[];
  say: string;
}

/** The DNA patterns your team prefers — suggested, never imposed. */
export const DNA_PATTERNS: DnaPattern[] = [
  {
    name: 'validation_before_write',
    triggers: [/handle|handler|endpoint|route|controller/i],
    say: 'your team validates inputs before they hit the data layer — add a schema check first',
  },
  {
    name: 'wrap_http_in_error_handling',
    triggers: [/\bfetch\b|axios|http\.|request/i],
    say: 'you are about to make an HTTP call — wrap it in error handling first?',
  },
  {
    name: 'transaction_bounded',
    triggers: [/transaction|begin|commit|rollback/i],
    say: 'your team bounds writes in a transaction so partial failures roll back cleanly',
  },
  {
    name: 'immutable_state',
    triggers: [/\blet\b|useState|mutable/i],
    say: 'this team prefers immutable state — derive the next value instead of mutating it',
  },
  {
    name: 'breathe',
    triggers: [],
    say: 'no obvious team pattern here — split the line and name the intent',
  },
];

export function detectPattern(edit: string): DnaPattern {
  return DNA_PATTERNS.find((p) => p.name === 'breathe' || p.triggers.some((re) => re.test(edit))) ?? DNA_PATTERNS[DNA_PATTERNS.length - 1]!;
}

export async function mirrorHint(userId: string, input: { edit: string }): Promise<PairHintRow> {
  if (!input.edit || typeof input.edit !== 'string') throw AppError.badRequest('edit_required', 'show me what you are typing');
  const pattern = detectPattern(input.edit);
  const id = newId(PREFIX.PAIR_HINT);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO pair_hints (id, owner_id, edit, pattern, suggestion, status) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, userId, input.edit, pattern.name, pattern.say, 'GIVEN'],
  ));
  await recordAudit({
    action: AuditAction.PAIR_HINT_GIVEN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'pair_hints',
    resourceId: id,
    detail: { pattern: pattern.name },
  });
  return getPairHint(userId, id);
}

export async function acknowledgeHint(userId: string, id: string): Promise<PairHintRow> {
  const hint = await getPairHint(userId, id);
  if (hint.status !== 'GIVEN') throw AppError.badRequest('hint_already_acknowledged', 'that hint was already acknowledged');
  await withTenant(userId, (q) => q.query('UPDATE pair_hints SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, 'ACKNOWLEDGED', userId]));
  await recordAudit({
    action: AuditAction.PAIR_HINT_ACKNOWLEDGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'pair_hints',
    resourceId: id,
    detail: { pattern: hint.pattern },
  });
  return getPairHint(userId, id);
}

export async function getPairHint(userId: string, id: string): Promise<PairHintRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM pair_hints WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('pair_hint_not_found', 'no pair hint found for that id');
  return rowOf(row);
}

export async function listPairHints(userId: string): Promise<PairHintRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM pair_hints WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function pairMirrorReport(userId: string): Promise<{ hints: number; acknowledged: number; patterns: number }> {
  const hints = await listPairHints(userId);
  return {
    hints: hints.length,
    acknowledged: hints.filter((h) => h.status === 'ACKNOWLEDGED').length,
    patterns: new Set(hints.map((h) => h.pattern)).size,
  };
}