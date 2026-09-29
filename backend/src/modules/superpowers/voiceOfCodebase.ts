/**
 * CodeConClave — Superpowers: VOICE-OF-CODEBASE (Master Feature #52).
 *
 * "How are you feeling today, billing service?" — the codebase answers with
 * your own data. Every answer is assembled from stored memory — postmortems,
 * the ontology dictionary, skill signals — and every answer is persisted with
 * its evidence sources so nothing is ever an ungrounded claim.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface CodebaseAnswerRow {
  id: string;
  owner_id: string;
  question: string;
  answer: string;
  evidence_sources: Array<{ kind: string; refId: string | null; snippet: string }>;
  created_at: Date;
}

const answerOf = (r: Record<string, unknown>): CodebaseAnswerRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  question: String(r.question),
  answer: String(r.answer),
  evidence_sources: Array.isArray(r.evidence_sources) ? (r.evidence_sources as CodebaseAnswerRow['evidence_sources']) : [],
  created_at: new Date(r.created_at as string),
});

export async function findAnswerById(userId: string, id: string): Promise<CodebaseAnswerRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, (q) =>
    q.query<Record<string, unknown>>('SELECT * FROM codebase_answers WHERE id = $1 AND owner_id = $2', [id, userId]).then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('codebase_answer_not_found', 'no answer found for that id');
  return answerOf(row);
}

export function answerTokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
}

/**
 * Answer a natural-language question deterministically from stored memory.
 * The snapshot line (postmortem / violation / skill-indicator counts) is always
 * present so even "how are you feeling" gets an honest, evidence-backed answer.
 */
export async function askCodebase(userId: string, question: string): Promise<CodebaseAnswerRow> {
  const q = (question ?? '').trim();
  if (!q) throw AppError.badRequest('empty_question', 'a question is required');
  const lower = q.toLowerCase();
  const tokens = answerTokens(lower);
  const evidence: CodebaseAnswerRow['evidence_sources'] = [];
  const lines: string[] = [];

  const [postmortems, terms, violations, signals] = await withTenant<
      [Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[]]
    >(userId, async (q) => {
      const [p, t, v, s] = await Promise.all([
        q.query<Record<string, unknown>>('SELECT * FROM postmortems WHERE owner_id = $1', [userId]).then((r) => r.rows),
        q.query<Record<string, unknown>>('SELECT * FROM ontology_terms WHERE owner_id = $1', [userId]).then((r) => r.rows),
        q.query<Record<string, unknown>>('SELECT * FROM ontology_violations WHERE owner_id = $1', [userId]).then((r) => r.rows),
        q.query<Record<string, unknown>>('SELECT * FROM skill_signals WHERE owner_id = $1', [userId]).then((r) => r.rows),
      ]);
      return [p, t, v, s];
    });

  // ---- 1) skill probe: "who knows X best?" / any token matching a known skill
  const knownSkills = [...new Set(signals.map((s) => String(s.skill)))];
  const skillProbe = /who knows|best at|expertise|skill/.test(lower);
  const tokenSkill = tokens.find((t) => knownSkills.some((k) => k.toLowerCase() === t));
  const skillName = tokenSkill ?? (skillProbe && knownSkills.length > 0 ? knownSkills[0] : null);
  if (skillName) {
    const perDev = new Map<string, number>();
    for (const s of signals) {
      if (String(s.skill).toLowerCase() !== skillName.toLowerCase()) continue;
      const dev = String(s.developer);
      perDev.set(dev, (perDev.get(dev) ?? 0) + Number(s.weight ?? 0));
    }
    const top = [...perDev.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? null;
    if (top) {
      lines.push(`"${skillName}" is best known by ${top[0]} (weight ${top[1]}).`);
      evidence.push({ kind: 'SKILL', refId: skillName, snippet: `${top[0]}:${top[1]}` });
    }
  }

  // ---- 2) term probe: a token matching an ontology term (canonical or alias)
  const termProbe = /term|ontology|concept|definition|means|what is|meaning/.test(lower);
  const matchedTerm = terms.find((t) => {
    const canon = String(t.canonical_name);
    const aliases = Array.isArray(t.aliases) ? (t.aliases as string[]) : [];
    return tokens.some((tok) => canon.toLowerCase() === tok || aliases.some((a) => a.toLowerCase() === tok));
  });
  if (termProbe || matchedTerm) {
    const seen = new Set<string>();
    const candidates = terms.filter((t) => {
      if (seen.has(String(t.canonical_name).toLowerCase())) return false;
      seen.add(String(t.canonical_name).toLowerCase());
      return true;
    });
    const t = matchedTerm ?? (candidates.length > 0 ? candidates[0] : null);
    if (t) {
      const openCount = violations.filter((v) => String(v.term_id) === String(t.id) && v.status === 'OPEN').length;
      lines.push(`${String(t.canonical_name)} — ${t.definition ? String(t.definition) : 'no definition yet'} — ${openCount} open violation(s).`);
      evidence.push({ kind: 'TERM', refId: String(t.id), snippet: String(t.canonical_name) });
    }
  }

  // ---- 3) incident probe
  if (/incident|postmortem|archive|blameless/.test(lower)) {
    const latest = postmortems.sort(
      (a, b) => new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime(),
    )[0] ?? null;
    if (latest) {
      const day = new Date(String(latest.created_at)).toISOString().slice(0, 10);
      lines.push(`${postmortems.length} incident(s) archived, most recent "${String(latest.title)}" (${day}).`);
      evidence.push({ kind: 'POSTMORTEM', refId: String(latest.id), snippet: String(latest.title) });
    } else {
      lines.push('no incidents archived yet.');
    }
  }

  // ---- 4) honest snapshot, always present
  const developerCount = new Set(signals.map((s) => String(s.developer))).size;
  lines.push(
    `memory: ${postmortems.length} postmortems, ${violations.filter((v) => v.status === 'OPEN').length} open ontology violations, ${signals.length} skill signals from ${developerCount} developers.`,
  );
  if (evidence.length === 0) evidence.push({ kind: 'SNAPSHOT', refId: null, snippet: lines[lines.length - 1]! });

  const id = newId(PREFIX.CODEBASE_ANSWER);
  await withTenant(userId, (client) =>
    client.query('INSERT INTO codebase_answers (id, owner_id, question, answer, evidence_sources) VALUES ($1,$2,$3,$4,$5::jsonb)', [
      id,
      userId,
      q,
      lines.join('\n'),
      JSON.stringify(evidence),
    ]),
  );
  await recordAudit({
    action: AuditAction.CODEBASE_ASKED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'codebase_answers',
    resourceId: id,
    detail: { question: q, evidence: evidence.length },
  });
  return findAnswerById(userId, id);
}

export async function listAnswers(userId: string, filter: { limit?: number } = {}): Promise<CodebaseAnswerRow[]> {
  const limit = Math.max(1, Math.min(filter.limit ?? 20, 50));
  const rows = (await withTenant<Record<string, unknown>[]>(userId, (client) =>
    client.query<Record<string, unknown>>('SELECT * FROM codebase_answers WHERE owner_id = $1', [userId]).then((r) => r.rows),
  ))
    .map(answerOf)
    .sort((a, b) => (b.created_at.getTime() - a.created_at.getTime()) || b.id.localeCompare(a.id));
  return rows.slice(0, limit);
}